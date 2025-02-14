import { appRootPath } from '@nrwl/tao/src/utils/app-root';
import { Task } from '@nrwl/devkit';
import { exists, lstat, readdir } from 'fs';
import {
  ensureDirSync,
  mkdir,
  unlink,
  ensureDir,
  writeFile,
  readFile,
  remove,
  copy,
} from 'fs-extra';
import { dirname, join, resolve, sep } from 'path';
import { DefaultTasksRunnerOptions } from './default-tasks-runner';
import { spawn } from 'child_process';
import { cacheDirectory } from '../utilities/cache-directory';

const util = require('util');

const readFileAsync = util.promisify(readFile);
const existsAsync = util.promisify(exists);
const lstatAsync = util.promisify(lstat);
const readdirAsync = util.promisify(readdir);

export type CachedResult = {
  terminalOutput: string;
  outputsPath: string;
  code: number;
};
export type TaskWithCachedResult = { task: Task; cachedResult: CachedResult };

export class Cache {
  root = appRootPath;
  cachePath = this.createCacheDir();
  terminalOutputsDir = this.createTerminalOutputsDir();
  latestOutputsHashesDir = this.ensureLatestOutputsHashesDir();

  constructor(private readonly options: DefaultTasksRunnerOptions) {}

  removeOldCacheRecords() {
    /**
     * Even though spawning a process is fast, we don't want to do it every time
     * the user runs a command. Instead, we want to do it once in a while.
     */
    const shouldSpawnProcess = Math.floor(Math.random() * 50) === 1;
    if (shouldSpawnProcess) {
      const scriptPath = require.resolve(
        '@nrwl/workspace/src/tasks-runner/remove-old-cache-records.js',
        { paths: [this.root] }
      );

      try {
        const p = spawn('node', [scriptPath, `"${this.cachePath}"`], {
          stdio: 'ignore',
          detached: true,
        });
        p.unref();
      } catch (e) {
        console.log(`Unable to start remove-old-cache-records script:`);
        console.log(e.message);
      }
    }
  }

  async get(task: Task): Promise<CachedResult> {
    const res = await this.getFromLocalDir(task);

    // didn't find it locally but we have a remote cache
    if (!res && this.options.remoteCache) {
      // attempt remote cache
      await this.options.remoteCache.retrieve(task.hash, this.cachePath);
      // try again from local cache
      return this.getFromLocalDir(task);
    } else {
      return res;
    }
  }

  async put(
    task: Task,
    terminalOutput: string | null,
    outputs: string[],
    code: number
  ) {
    const td = join(this.cachePath, task.hash);
    const tdCommit = join(this.cachePath, `${task.hash}.commit`);

    // might be left overs from partially-completed cache invocations
    await remove(tdCommit);
    await remove(td);

    await mkdir(td);
    await writeFile(
      join(td, 'terminalOutput'),
      terminalOutput ?? 'no terminal output'
    );

    await mkdir(join(td, 'outputs'));
    for (const f of outputs) {
      const src = join(this.root, f);
      if (await existsAsync(src)) {
        const cached = join(td, 'outputs', f);
        // Ensure parent directory is created if src is a file
        const isFile = (await lstatAsync(src)).isFile();
        const directory = isFile ? resolve(cached, '..') : cached;
        await ensureDir(directory);

        await copy(src, cached);
      }
    }
    // we need this file to account for partial writes to the cache folder.
    // creating this file is atomic, whereas creating a folder is not.
    // so if the process gets terminated while we are copying stuff into cache,
    // the cache entry won't be used.
    await writeFile(join(td, 'code'), code.toString());
    await writeFile(tdCommit, 'true');

    if (this.options.remoteCache) {
      await this.options.remoteCache.store(task.hash, this.cachePath);
    }
  }

  async copyFilesFromCache(
    hash: string,
    cachedResult: CachedResult,
    outputs: string[]
  ) {
    await this.removeRecordedOutputsHashes(outputs);
    for (const f of outputs) {
      const cached = join(cachedResult.outputsPath, f);
      if (await existsAsync(cached)) {
        const isFile = (await lstatAsync(cached)).isFile();
        const src = join(this.root, f);
        await remove(src);

        // Ensure parent directory is created if src is a file
        const directory = isFile ? resolve(src, '..') : src;
        await ensureDir(directory);
        await copy(cached, src);
      }
    }
    await this.recordOutputsHash(outputs, hash);
  }

  temporaryOutputPath(task: Task) {
    return join(this.terminalOutputsDir, task.hash);
  }

  async removeRecordedOutputsHashes(outputs: string[]): Promise<void> {
    for (const output of outputs) {
      const hashFile = this.getFileNameWithLatestRecordedHashForOutput(output);
      try {
        await unlink(hashFile);
      } catch (e) {}
    }
  }

  async recordOutputsHash(outputs: string[], hash: string): Promise<void> {
    for (const output of outputs) {
      const hashFile = this.getFileNameWithLatestRecordedHashForOutput(output);
      try {
        await ensureDir(dirname(hashFile));
        await writeFile(hashFile, hash);
      } catch {}
    }
  }

  async shouldCopyOutputsFromCache(
    taskWithCachedResult: TaskWithCachedResult,
    outputs: string[]
  ): Promise<boolean> {
    return (
      (await this.areLatestOutputsHashesDifferentThanTaskHash(
        outputs,
        taskWithCachedResult.task.hash
      )) ||
      (await this.isAnyOutputMissing(
        taskWithCachedResult.cachedResult,
        outputs
      ))
    );
  }

  private async areLatestOutputsHashesDifferentThanTaskHash(
    outputs: string[],
    hash: string
  ) {
    for (let output of outputs) {
      if ((await this.getLatestRecordedHashForTask(output)) !== hash)
        return true;
    }
    return false;
  }

  private async getLatestRecordedHashForTask(
    output: string
  ): Promise<string | null> {
    try {
      return (
        await readFileAsync(
          this.getFileNameWithLatestRecordedHashForOutput(output)
        )
      ).toString();
    } catch (e) {
      return null;
    }
  }

  private async isAnyOutputMissing(
    cachedResult: CachedResult,
    outputs: string[]
  ): Promise<boolean> {
    for (let output of outputs) {
      const cacheOutputPath = join(cachedResult.outputsPath, output);
      const rootOutputPath = join(this.root, output);

      if (
        (await existsAsync(cacheOutputPath)) &&
        (await lstatAsync(cacheOutputPath)).isFile()
      ) {
        if (
          (await existsAsync(join(cachedResult.outputsPath, output))) &&
          !(await existsAsync(join(this.root, output)))
        ) {
          return true;
        }
      }

      const haveDifferentAmountOfFiles =
        (await existsAsync(cacheOutputPath)) &&
        (await existsAsync(rootOutputPath)) &&
        (await readdirAsync(cacheOutputPath)).length !==
          (await readdirAsync(rootOutputPath)).length;

      if (
        ((await existsAsync(cacheOutputPath)) &&
          !(await existsAsync(rootOutputPath))) ||
        haveDifferentAmountOfFiles
      ) {
        return true;
      }
    }
    return false;
  }

  private getFileNameWithLatestRecordedHashForOutput(output: string): string {
    return join(
      this.latestOutputsHashesDir,
      `${output.split(sep).join('-')}.hash`
    );
  }

  private async getFromLocalDir(task: Task) {
    const tdCommit = join(this.cachePath, `${task.hash}.commit`);
    const td = join(this.cachePath, task.hash);

    if (await existsAsync(tdCommit)) {
      const terminalOutput = await readFile(
        join(td, 'terminalOutput'),
        'utf-8'
      );
      let code = 0;
      try {
        code = Number(await readFile(join(td, 'code'), 'utf-8'));
      } catch (e) {}
      return {
        terminalOutput,
        outputsPath: join(td, 'outputs'),
        code,
      };
    } else {
      return null;
    }
  }

  private createCacheDir() {
    const dir = cacheDirectory(this.root, this.options.cacheDirectory);
    ensureDirSync(dir);
    return dir;
  }

  private createTerminalOutputsDir() {
    const path = join(this.cachePath, 'terminalOutputs');
    ensureDirSync(path);
    return path;
  }

  private ensureLatestOutputsHashesDir() {
    const path = join(this.cachePath, 'latestOutputsHashes');
    ensureDirSync(path);
    return path;
  }
}
