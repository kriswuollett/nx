# CliArgsMangled

This project was generated using [Nx](https://nx.dev).

## Reproducing the issue

Create an execute target with the `@nrwl/workspace:run-commands` executor, and
then run it along with passing some command line arguments. The target
`execute` serves that purpose in this test project. Here is a sample of the
issue:

```console
$ nx run my-app:execute -- -a --an-arg 3 --another-arg=test --= foo

> nx run my-app:execute --a --anArg=3 --anotherArg=test --==foo
process.argv.slice(2):
[ '--a=true', '--anArg=3', '--anotherArg=test', '---==foo', '--==foo' ]

———————————————————————————————————————————————

>  NX   SUCCESS  Running target "execute" succeeded


```

Note the following argument mangling issues:

1. A single argument is being transformed as if it was a `boolean` argument, e.g., `-a` is mapped to `--a=true`.
2. Long form args that aren't joined with their value with an equals sign is forced into that format, e.g., `--an-arg 3` which should be two separate entries in `argv` is instead squashed into `--an-arg=3`.
3. Dashes are removed from argument names, and then the name is converted into camel case, e.g., `--another-arg=test` gets transformed into `--anotherArg=test`.
4. Argument processing does not handle free form arguments with equal signs, e.g., `--= foo` in an intermediate stage gets squashed to `--==foo` when the command is echoed, and then it gets processed again into two separate `argv` entries: `---==foo` and `--==foo`.
