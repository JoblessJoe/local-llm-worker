# Benchmark

Measures how reliably a local model passes `delegate` tasks against a real backend.

```sh
node bench/run.mjs --models qwen3-coder:30b,granite4.1:8b --runs 5 --parallel 4
```

- Six tasks in `tasks/`, each with a spec, properties and hidden tests: a pure function,
  a parser, a stateful class, a change to an existing file, a Python/pytest task, and a
  deliberately under-specified spec.
- Each run gets a fresh git repo. Sources are committed and tests are left uncommitted, the way
  they are right after Claude writes them.
- Results go to `bench/results/*.jsonl`, and a pass@1 / pass@3 table is printed.
- Backend settings come from the usual `LLW_*` env vars. `--python` picks the interpreter for
  the pytest task (it needs `pytest` installed).
