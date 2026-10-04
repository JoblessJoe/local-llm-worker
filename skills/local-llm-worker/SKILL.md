---
name: local-llm-worker
description: Use the user's local LLM so bulk tokens stay out of your context. Use when you are about to run a test suite, build or command with long output, read a log, or open a large file just to find one thing (offload); when you need to look something up on the web, check docs or verify current versions (research, instead of WebSearch/WebFetch); or when asked to add, write or implement a small function, helper or file that tests can pin down (write the test, then delegate). Also for setting up or changing the plugin (configure). Not for tiny inputs or work the user wants done by you.
---

# local-llm-worker

Three tools run on the user's own hardware, so the bulk tokens never touch your context:

- **`offload`**: the local model reads `files` and/or the output of `command` and answers `task`.
  You get the answer plus one footer line. Use it instead of reading a 5,000-line log or a large
  file just to find one fact.
- **`research`**: the local model searches SearXNG (or reads the `urls` you give), reads the
  pages in full and answers with [n] citations. Use it instead of WebSearch/WebFetch when the
  details on the pages matter, or to read long docs pages without pulling them into context.
- **`delegate`**: the local model writes `target_file` in an isolated git worktree, runs your
  `test_command`, gets parsed failures back, retries, and copies the file in on PASS. You get a
  ~60-token verdict.

## First run: call `configure`

Call `configure` with no arguments. It reports the effective config, where each value came
from, the config file paths, the detected API (ollama / openai), whether the backend is
reachable and which models it serves.

- Not reachable → ask the user where their model server runs, then
  `configure {"set": {"base_url": "http://host:port"}}`.
- Several models and none set → pick with the user and
  `configure {"set": {"model": "<name>"}}`. Optionally `offload_model` (long context) and
  `delegate_model` (a coder model).
- `research` without `urls` needs `search_url` (a SearXNG instance with JSON output). If it's
  unset, tell the user how to start one (see the error text) or use `urls`.
- CPU-only or slow box → raise `timeout_ms`; big files → raise `num_ctx` (Ollama).
- **Ask the user how they want to use it**, then save the answer (AskUserQuestion if available,
  multi-select). These are the tools you will use on your own:
  - `offload` (recommended): run noisy commands and read big files through the local model.
  - `research` (recommended): web lookups through the local model.
  - `delegate` (optional): hand implementations to the local model. It's slower, and only pays off
    for code bigger than its tests.
  Save it with `configure {"set": {"auto_use": [...]}}`. `[]` means "only when I ask".
- **Offer to enforce it in CLAUDE.md.** A session reminder is a nudge; an instruction in CLAUDE.md
  is followed far more reliably. If the user wants that, append the snippet below to the CLAUDE.md
  they choose (`~/.claude/CLAUDE.md` for all projects, or the project's own), with only the
  lines for the tools they picked. Show them the text first.

  ```markdown
  ## Local LLM (local-llm-worker)
  - Run test suites, builds and other noisy commands through `offload` (`command`), and read logs or files over ~300 lines through it, instead of reading the output yourself.
  - Use `research` for web lookups instead of WebSearch/WebFetch.
  - For new functions or files bigger than their tests: write the tests first, then `delegate` the implementation. Run independent delegates in parallel.
  ```
- `scope: "project"` writes `<git root>/.local-llm-worker.json` instead of the user file.
  A `null` value removes a key. Changes apply on the next call; nothing restarts.

## Delegate playbook

0. **A bad spec is indistinguishable from a bad model.** The same model scored 0/6 and 5/5;
   only the spec changed. Three fails on the same invariant → fix the spec, don't swap the model.
1. **Every stated invariant maps 1:1 to a gating test.** Write the test file first, then one
   numbered invariant in `properties` per test. Count them.
2. **`context` carries the exact API surface verbatim**: helper names with return shapes,
   table/column names, dialect quirks. Anything omitted gets invented.
3. **State invariants as properties, keep examples hidden.** "Amounts always sum to exactly the
   total" is safe to show; concrete input/output pairs invite hardcoding, so keep them in the
   tests only. The worker never sees test source, only parsed failures.
4. **Delegate by how idiomatic, not how architectural.** Well-trodden boilerplate passes; novel
   arithmetic and algorithms fail more, even when "simpler".
5. **Delegate by blast radius.** Never auth, money, tenant scoping or security. Read the diff
   before relying on anything: `show_code: false` saves iteration tokens, it is not a review.
6. **Leave `show_code` false.** That is the saving: a short verdict instead of the code.
7. **Never let the worker resolve real ambiguity** (business rules with no single right
   answer). The same ticket run twice gave two different discount rules. Decide it in the spec.
8. **Parallelize independent delegates** in one turn; each gets its own worktree.
9. **One coherent spec beats several tiny ones**; per-call overhead amortizes with scope.

## Calling `delegate`

```json
{
  "spec": "What the file does, with every decision already made.",
  "target_file": "src/slugify.js",
  "test_command": "node --test test/slugify.test.js",
  "test_files": ["test/slugify.test.js"],
  "properties": ["Output only contains [a-z0-9-]", "Never starts or ends with '-'"],
  "context": "export function slugify(input: string): string  (ESM, no dependencies)"
}
```

- The test may be uncommitted; the worktree mirrors your uncommitted changes.
- `node_modules`, `.venv`, `venv`, `vendor` are symlinked in so tests can run (`link_dirs`).
- If the target exists, the worker modifies it and returns the complete new file.
- **FAIL**: the worktree is kept and its path is reported. Inspect it, improve the spec, retry,
  then remove it with the `git worktree remove --force <path>` line from the result.
- **PASS, applied: no**: the file changed in the checkout during the run (or `apply: false`).
  The passing file is in the reported worktree.
- An `Error:` result (backend unreachable, timeout) is a transport problem, not a model
  failure. Fix the config instead of rewriting the spec.

## Calling `offload`

```json
{ "task": "Which tests failed and what were the assertion messages?", "command": "npm test 2>&1" }
```

Ask precise questions. Answers quote exact lines and paths; verify anything you will act on.
If the result says the material was cut, narrow the files or raise `num_ctx`.

## Calling `research`

```json
{ "question": "Which Node.js versions are in LTS right now, and when does each reach end of life?" }
{ "question": "What fields does package.json need for the MCP registry?", "urls": ["https://..."] }
```

Phrase the question so it can also serve as the search query, or pass a separate `query`. The
answer is only as good as the pages it found: check the source list, and spot-check anything
critical yourself. Several independent questions can run in parallel.
