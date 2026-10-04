import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  loadConfig, configure, offload, delegate, detectApi, chat, extractFailures,
  extractCode, normalizeBaseUrl, stripThink, DEFAULTS, research, htmlToText, run,
} from '../src/worker.js';
import {
  tmpdir, sh, write, makeRepo, fakeBackend, fakeWeb, makeCtx, TAP_CMD, nodeCmd, baseEnv,
  ADD_TEST, GOOD_ADD, BAD_ADD, worktrees,
  SUITE,
} from './helpers.js';

// ---------------------------------------------------------------------------

describe('delegate', SUITE, () => {
  test('PASS on attempt 1 applies the file and removes the worktree', async () => {
    const be = await fakeBackend({ reply: () => GOOD_ADD });
    try {
      const root = await makeRepo();
      await write(path.join(root, 'test/add.test.js'), ADD_TEST); // uncommitted
      const ctx = await makeCtx(root, { LLW_BASE_URL: be.url, LLW_MODEL: 'test-model' });
      const out = await delegate({
        spec: 'Export add(a, b) returning the sum.',
        target_file: 'src/add.js',
        test_command: TAP_CMD('test/add.test.js'),
        test_files: ['test/add.test.js'],
      }, ctx);
      assert.match(out, /^PASS · attempt 1\/3 · src\/add\.js \(3 lines\) · applied: yes/);
      assert.match(out, /20 tokens generated locally/);
      assert.doesNotMatch(out, /return a \+ b/, 'code is not returned unless show_code');
      assert.match(await fs.readFile(path.join(root, 'src/add.js'), 'utf8'), /return a \+ b/);
      assert.deepEqual(await worktrees(root), [root]);
      assert.equal(be.requests.length, 1);
      assert.match(be.requests[0].user, /## Target file: src\/add\.js/);
      assert.equal(be.requests[0].body.options.temperature, 0.2);
    } finally {
      await be.close();
    }
  });

  test('FAIL then PASS: retry gets parsed failures, never the test source', async () => {
    const be = await fakeBackend({ reply: (req, n) => (n === 1 ? BAD_ADD : GOOD_ADD) });
    try {
      const root = await makeRepo();
      await write(path.join(root, 'test/add.test.js'), ADD_TEST);
      const ctx = await makeCtx(root, { LLW_BASE_URL: be.url, LLW_MODEL: 'test-model' });
      const out = await delegate({
        spec: 'Export add(a, b) returning the sum.',
        target_file: 'src/add.js',
        test_command: TAP_CMD('test/add.test.js'),
        show_code: true,
      }, ctx);
      assert.match(out, /^PASS · attempt 2\/3/);
      assert.match(out, /return a \+ b/, 'show_code returns the code');
      const retry = be.requests[1].user;
      assert.match(retry, /## Your previous attempt FAILED\. Fix it\./);
      assert.match(retry, /FAILED: adds two numbers/);
      assert.match(retry, /expected: 5/);
      assert.match(retry, /actual: -1/);
      assert.doesNotMatch(retry, /SECRET_TEST_SOURCE_MARKER/);
      assert.doesNotMatch(retry, /import \{ add \}/);
      assert.doesNotMatch(retry, /stack:|duration_ms|location:/);
      assert.doesNotMatch(be.requests[0].user, /SECRET_TEST_SOURCE_MARKER/);
    } finally {
      await be.close();
    }
  });

  test('FAIL after N attempts keeps the worktree and reports it', async () => {
    const be = await fakeBackend({ reply: () => BAD_ADD });
    try {
      const root = await makeRepo();
      await write(path.join(root, 'test/add.test.js'), ADD_TEST);
      const ctx = await makeCtx(root, { LLW_BASE_URL: be.url, LLW_MODEL: 'test-model' });
      const out = await delegate({
        spec: 'Export add(a, b) returning the sum.',
        target_file: 'src/add.js',
        test_command: TAP_CMD('test/add.test.js'),
        max_attempts: 2,
      }, ctx);
      assert.match(out, /^FAIL · attempt 2\/2 · src\/add\.js \(3 lines\) · applied: no/);
      assert.match(out, /Last failure:\nFAILED: adds two numbers/);
      const kept = /Worktree kept: (\S+)/.exec(out)[1];
      assert.match(out, new RegExp(`git worktree remove --force ${kept.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
      assert.ok((await worktrees(root)).includes(kept));
      assert.match(await fs.readFile(path.join(kept, 'src/add.js'), 'utf8'), /a - b/);
      await assert.rejects(fs.access(path.join(root, 'src/add.js')), 'nothing applied on FAIL');
      assert.equal(be.requests.length, 2);
      await sh(root, 'git', 'worktree', 'remove', '--force', kept);
    } finally {
      await be.close();
    }
  });

  test('jail: target outside the root is refused', async () => {
    const root = await makeRepo();
    const ctx = await makeCtx(root, { LLW_BASE_URL: 'http://127.0.0.1:9', LLW_MODEL: 'm' });
    await assert.rejects(
      delegate({ spec: 's', target_file: '../x.js', test_command: 'true' }, ctx),
      /outside the project root/,
    );
  });

  test('jail: target that is a test file is refused', async () => {
    const root = await makeRepo();
    const ctx = await makeCtx(root, { LLW_BASE_URL: 'http://127.0.0.1:9', LLW_MODEL: 'm' });
    await assert.rejects(
      delegate({
        spec: 's', target_file: 'test/add.test.js', test_command: 'true', test_files: ['./test/../test/add.test.js'],
      }, ctx),
      /is one of the test_files/,
    );
  });

  test('not a git repo / no commits give clear errors', async () => {
    const plain = await tmpdir();
    const ctx = await makeCtx(plain, { LLW_MODEL: 'm' });
    await assert.rejects(delegate({ spec: 's', target_file: 'a.js', test_command: 'true' }, ctx), /needs a git repository/);
    await sh(plain, 'git', 'init', '-q');
    await assert.rejects(delegate({ spec: 's', target_file: 'a.js', test_command: 'true' }, ctx), /no commits/);
  });

  test('apply conflict: target changed in the checkout mid-run is not overwritten', async () => {
    let root;
    const be = await fakeBackend({
      reply: async () => {
        await write(path.join(root, 'src/add.js'), '// user edit\n');
        return GOOD_ADD;
      },
    });
    try {
      root = await makeRepo();
      await write(path.join(root, 'test/add.test.js'), ADD_TEST);
      const ctx = await makeCtx(root, { LLW_BASE_URL: be.url, LLW_MODEL: 'test-model' });
      const out = await delegate({
        spec: 'Export add(a, b) returning the sum.',
        target_file: 'src/add.js',
        test_command: TAP_CMD('test/add.test.js'),
      }, ctx);
      assert.match(out, /^PASS · attempt 1\/3 .* applied: no/);
      assert.match(out, /changed in the checkout during the run/);
      assert.equal(await fs.readFile(path.join(root, 'src/add.js'), 'utf8'), '// user edit\n');
      const kept = /Worktree kept: (\S+)/.exec(out)[1];
      assert.match(await fs.readFile(path.join(kept, 'src/add.js'), 'utf8'), /a \+ b/);
      await sh(root, 'git', 'worktree', 'remove', '--force', kept);
    } finally {
      await be.close();
    }
  });

  test('existing target: current content is sent for modification', async () => {
    const be = await fakeBackend({ reply: () => GOOD_ADD });
    try {
      const root = await makeRepo();
      await write(path.join(root, 'src/add.js'), 'export function add() { /* ORIGINAL */ }\n');
      await sh(root, 'git', 'add', '.');
      await sh(root, 'git', 'commit', '-q', '-m', 'add stub');
      await write(path.join(root, 'test/add.test.js'), ADD_TEST);
      const ctx = await makeCtx(root, { LLW_BASE_URL: be.url, LLW_MODEL: 'test-model' });
      const out = await delegate({
        spec: 'Make add return the sum.', target_file: 'src/add.js', test_command: TAP_CMD('test/add.test.js'),
      }, ctx);
      assert.match(out, /^PASS/);
      assert.match(be.requests[0].user, /## Current content of src\/add\.js — modify this; return the COMPLETE new file/);
      assert.match(be.requests[0].user, /ORIGINAL/);
    } finally {
      await be.close();
    }
  });

  test('uncommitted state is mirrored into the worktree', async () => {
    const be = await fakeBackend({ reply: () => 'export const x = 1;' });
    try {
      const root = await makeRepo();
      await write(path.join(root, 'data.txt'), 'committed\n');
      await write(path.join(root, 'gone.txt'), 'bye\n');
      await sh(root, 'git', 'add', '.');
      await sh(root, 'git', 'commit', '-q', '-m', 'files');
      await write(path.join(root, 'data.txt'), 'modified\n'); // tracked, modified
      await fs.rm(path.join(root, 'gone.txt')); // tracked, deleted
      await write(path.join(root, 'test/new.test.js'), 'untracked\n'); // untracked
      await write(path.join(root, 'node_modules/dep/index.js'), 'dep\n'); // linked dir
      const ctx = await makeCtx(root, { LLW_BASE_URL: be.url, LLW_MODEL: 'test-model' });
      const out = await delegate({
        spec: 'x',
        target_file: 'src/x.js',
        test_command: nodeCmd("const f=require('fs');process.exit(f.existsSync('test/new.test.js')"
          + "&&f.readFileSync('data.txt','utf8').includes('modified')&&!f.existsSync('gone.txt')"
          + "&&f.lstatSync('node_modules').isSymbolicLink()&&f.existsSync('node_modules/dep/index.js')?0:1)"),
      }, ctx);
      assert.match(out, /^PASS · attempt 1\/3/, out);
      assert.equal(await fs.readFile(path.join(root, 'node_modules/dep/index.js'), 'utf8'), 'dep\n');
      assert.deepEqual(await worktrees(root), [root]);
    } finally {
      await be.close();
    }
  });

  test('3 parallel delegates to different files all PASS and overlap in time', async () => {
    const be = await fakeBackend({
      delay: 400,
      reply: (req) => {
        const name = /## Target file: src\/(\w+)\.js/.exec(req.user)[1];
        return `\`\`\`js\nexport const ${name} = '${name}';\n\`\`\``;
      },
    });
    try {
      const root = await makeRepo();
      const names = ['alpha', 'beta', 'gamma'];
      for (const n of names) {
        await write(path.join(root, `test/${n}.test.js`), `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ${n} } from '../src/${n}.js';
test('${n}', () => assert.equal(${n}, '${n}'));
`);
      }
      const ctx = await makeCtx(root, { LLW_BASE_URL: be.url, LLW_MODEL: 'test-model' });
      const outs = await Promise.all(names.map((n) => delegate({
        spec: `Export const ${n} = '${n}'.`,
        target_file: `src/${n}.js`,
        test_command: TAP_CMD(`test/${n}.test.js`),
      }, ctx)));
      for (const out of outs) assert.match(out, /^PASS · attempt 1\/3 .* applied: yes/, out);
      assert.ok(be.maxInFlight >= 2, `requests overlapped (max in flight ${be.maxInFlight})`);
      assert.deepEqual(await worktrees(root), [root]);
    } finally {
      await be.close();
    }
  });

  test('transport failure is an error, not a FAIL verdict, and cleans up', async () => {
    const root = await makeRepo();
    const ctx = await makeCtx(root, { LLW_BASE_URL: 'http://127.0.0.1:9', LLW_MODEL: 'm', LLW_API: 'ollama' });
    await assert.rejects(
      delegate({ spec: 's', target_file: 'a.js', test_command: 'true' }, ctx),
      /Backend request failed: POST http:\/\/127\.0\.0\.1:9\/api\/chat \(model "m"\)/,
    );
    assert.deepEqual(await worktrees(root), [root]);
  });
});

// ---------------------------------------------------------------------------

describe('extractFailures', SUITE, () => {
  test('TAP: failing tests with YAML, minus stack and noise', () => {
    const tap = `TAP version 13
# Subtest: adds numbers
not ok 1 - adds numbers
  ---
  duration_ms: 2.307727
  type: 'test'
  location: '/tmp/x/a.test.js:5:1'
  failureType: 'testCodeFailure'
  error: |-
    Expected values to be strictly equal:

    -1 !== 5

  code: 'ERR_ASSERTION'
  expected: 5
  actual: -1
  operator: 'strictEqual'
  stack: |-
    TestContext.<anonymous> (file:///tmp/x/a.test.js:5:37)
    Test.runInAsyncScope (node:async_hooks:214:14)
  ...
# Subtest: ok one
ok 2 - ok one
  ---
  duration_ms: 0.29
  ...
# Subtest: suite
    # Subtest: inner
    not ok 1 - inner
      ---
      duration_ms: 3.17
      error: 'boom'
      stack: |-
        at x
      ...
    1..1
not ok 3 - suite
  ---
  duration_ms: 3.5
  type: 'suite'
  failureType: 'subtestsFailed'
  error: '1 subtest failed'
  ...
1..3
# tests 3
# pass 1
# fail 2
`;
    const out = extractFailures(tap);
    assert.match(out, /^FAILED: adds numbers\n/);
    assert.match(out, /-1 !== 5/);
    assert.match(out, /expected: 5\nactual: -1/);
    assert.match(out, /FAILED: inner\nerror: 'boom'/);
    assert.doesNotMatch(out, /FAILED: suite/);
    assert.doesNotMatch(out, /FAILED: ok one/);
    assert.doesNotMatch(out, /stack|TestContext|async_hooks|duration_ms|location|failureType|# tests/);
  });

  test('TAP: file that crashed on import includes the diagnostics', () => {
    const tap = `TAP version 13
# Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/x/nope.js' imported from /x/b.test.js
# Subtest: b.test.js
not ok 1 - b.test.js
  ---
  duration_ms: 79.6
  exitCode: 1
  error: 'test failed'
  ...
1..1
# tests 1
`;
    const out = extractFailures(tap);
    assert.match(out, /Cannot find module '\/x\/nope\.js'/);
    assert.match(out, /FAILED: b\.test\.js/);
    assert.doesNotMatch(out, /# tests/);
  });

  test('pytest: assertion lines with context, deduped', () => {
    const lines = [];
    for (let i = 0; i < 40; i++) lines.push(`collected line ${i}`);
    const pytest = `============================= test session starts ==============================
platform linux -- Python 3.12.0, pytest-8.0.0
${lines.join('\n')}
tests/test_calc.py F.                                                    [100%]

=================================== FAILURES ===================================
_________________________________ test_total __________________________________

    def test_total():
>       assert total([1, 2]) == 4
E       assert 3 == 4
E        +  where 3 = total([1, 2])

tests/test_calc.py:5: AssertionError
=========================== short test summary info ============================
FAILED tests/test_calc.py::test_total - assert 3 == 4
========================= 1 failed, 1 passed in 0.02s ==========================
`;
    const out = extractFailures(pytest);
    assert.match(out, /E {7}assert 3 == 4/);
    assert.match(out, /where 3 = total\(\[1, 2\]\)/);
    assert.match(out, /FAILED tests\/test_calc\.py::test_total/);
    assert.doesNotMatch(out, /collected line 5\b/, 'unrelated lines dropped');
    assert.equal(out.split('\n').filter((l) => l === 'E       assert 3 == 4').length, 1, 'deduped');
  });

  test('crash with no recognisable failure keeps the head, not the tail', () => {
    const filler = Array.from({ length: 500 }, (_, i) => `# command-line-arguments line ${i}`).join('\n');
    const out = extractFailures(`./calc.go:3:1: syntax error: non-declaration statement outside function body\n${filler}\nTAIL_MARKER`);
    assert.match(out, /^\.\/calc\.go:3:1: syntax error/);
    assert.doesNotMatch(out, /TAIL_MARKER/);
    assert.ok(out.length <= 1500 + '\n[... truncated]'.length);
  });

  test('output is capped at 1500 characters', () => {
    const out = extractFailures(Array.from({ length: 500 }, (_, i) => `Error number ${i}`).join('\n'));
    assert.ok(out.length <= 1500 + '\n[... truncated]'.length);
  });
});

// ---------------------------------------------------------------------------

describe('config', SUITE, () => {
  test('api_key from plugin settings (keychain) fills in only when nothing else set it', async () => {
    const ctx = await makeCtx(await tmpdir(), { LLW_PLUGIN_API_KEY: 'from-keychain' });
    let { config, sources } = await loadConfig(ctx);
    assert.equal(config.api_key, 'from-keychain');
    assert.equal(sources.api_key, 'plugin settings (keychain)');
    ({ config } = await loadConfig({ ...ctx, env: { ...ctx.env, LLW_API_KEY: 'explicit' } }));
    assert.equal(config.api_key, 'explicit');
    for (const unset of ['', '${user_config.api_key}']) {
      ({ config } = await loadConfig({ ...ctx, env: { ...ctx.env, LLW_PLUGIN_API_KEY: unset } }));
      assert.equal(config.api_key, '', JSON.stringify(unset));
    }
  });

  test('layering: defaults < user < project < env, with sources', async () => {
    const root = await makeRepo();
    const ctx = await makeCtx(path.join(root), { LLW_NUM_CTX: '8192', LLW_LINK_DIRS: 'a, b' });
    await write(path.join(ctx.env.XDG_CONFIG_HOME, 'local-llm-worker/config.json'),
      JSON.stringify({ model: 'user-model', base_url: 'http://box:1234/v1/', num_ctx: 1000, concurrency: 2 }));
    await write(path.join(root, '.local-llm-worker.json'), JSON.stringify({ model: 'project-model', concurrency: 'x' }));
    await fs.mkdir(path.join(root, 'sub'));
    const { config, sources, files, warnings } = await loadConfig({ ...ctx, cwd: path.join(root, 'sub') });
    assert.equal(config.model, 'project-model');
    assert.equal(sources.model, 'project');
    assert.equal(config.base_url, 'http://box:1234');
    assert.equal(sources.base_url, 'user');
    assert.equal(config.num_ctx, 8192);
    assert.equal(sources.num_ctx, 'env LLW_NUM_CTX');
    assert.deepEqual(config.link_dirs, ['a', 'b']);
    assert.equal(config.concurrency, 2, 'invalid project value ignored');
    assert.match(warnings.join('\n'), /concurrency must be a positive integer/);
    assert.equal(config.timeout_ms, DEFAULTS.timeout_ms);
    assert.equal(sources.timeout_ms, 'default');
    assert.equal(files.project, path.join(root, '.local-llm-worker.json'));
  });

  test('configure set/unset, unknown key rejected, re-read without restart', async () => {
    const be = await fakeBackend({ models: ['a', 'b'] });
    try {
      const root = await makeRepo();
      const ctx = await makeCtx(root, { LLW_BASE_URL: be.url });
      let report = JSON.parse(await configure({}, ctx));
      assert.equal(report.reachable, true);
      assert.deepEqual(report.models, ['a', 'b']);
      assert.equal(report.api, 'ollama (auto-detected)');
      assert.equal(report.resolved_models.delegate, null);

      report = JSON.parse(await configure({ set: { model: 'a', delegate_model: 'b', num_ctx: 4096 }, scope: 'project' }, ctx));
      assert.equal(report.effective.model, 'a');
      assert.equal(report.sources.model, 'project');
      assert.deepEqual(report.resolved_models, { offload: 'a', delegate: 'b', research: 'a' });
      const file = JSON.parse(await fs.readFile(path.join(root, '.local-llm-worker.json'), 'utf8'));
      assert.deepEqual(file, { model: 'a', delegate_model: 'b', num_ctx: 4096 });

      report = JSON.parse(await configure({ set: { delegate_model: null } , scope: 'project' }, ctx));
      assert.equal(report.effective.delegate_model, '');
      assert.equal(report.sources.delegate_model, 'default');

      await configure({ set: { concurrency: 8 } }, ctx);
      assert.equal((await loadConfig(ctx)).sources.concurrency, 'user');

      await assert.rejects(configure({ set: { modle: 'x' } }, ctx), /Unknown key "modle"\. Valid keys: base_url, api/);
      await assert.rejects(configure({ set: { num_ctx: 'big' } }, ctx), /num_ctx must be a positive integer/);
      await assert.rejects(configure({ set: { max_attempts: 11 } }, ctx), /from 1 to 10/);

      // Edited by hand: the next call sees it.
      await fs.writeFile(path.join(root, '.local-llm-worker.json'), JSON.stringify({ model: 'b' }));
      assert.equal((await loadConfig(ctx)).config.model, 'b');
    } finally {
      await be.close();
    }
  });

  test('model resolution: one model is used, several is an error naming them', async () => {
    const one = await fakeBackend({ models: ['only-one'], reply: () => 'answer' });
    const many = await fakeBackend({ models: ['m1', 'm2'], reply: () => 'answer' });
    try {
      const root = await makeRepo();
      let ctx = await makeCtx(root, { LLW_BASE_URL: one.url });
      const out = await offload({ task: 'q', files: ['README.md'] }, ctx);
      assert.match(out, /only-one/);
      assert.equal(one.requests[0].body.model, 'only-one');
      ctx = await makeCtx(root, { LLW_BASE_URL: many.url });
      await assert.rejects(offload({ task: 'q', files: ['README.md'] }, ctx), /lists 2 models: m1, m2\. Call configure/);
    } finally {
      await one.close();
      await many.close();
    }
  });
});

// ---------------------------------------------------------------------------

describe('backend', SUITE, () => {
  test('auto API detection picks ollama vs openai and uses the right endpoint', async () => {
    const ol = await fakeBackend({ kind: 'ollama', reply: () => 'from ollama' });
    const oa = await fakeBackend({ kind: 'openai', reply: () => '<think>hmm</think>from openai' });
    try {
      const base = { ...DEFAULTS, api: 'auto', num_ctx: 1234 };
      const olCfg = { ...base, base_url: ol.url };
      const oaCfg = { ...base, base_url: `${oa.url}/v1`, api_key: 'sk-test' };
      oaCfg.base_url = normalizeBaseUrl(oaCfg.base_url);
      assert.equal(await detectApi(olCfg), 'ollama');
      assert.equal(await detectApi(oaCfg), 'openai');
      assert.equal(await detectApi({ ...olCfg, api: 'openai' }), 'openai', 'explicit api wins');

      const messages = [{ role: 'user', content: 'hi' }];
      const r1 = await chat({ config: olCfg, api: 'ollama', model: 'm', messages, temperature: 0.1 });
      assert.equal(r1.content, 'from ollama');
      assert.equal(ol.requests[0].url, '/api/chat');
      assert.equal(ol.requests[0].body.options.num_ctx, 1234);
      assert.equal(ol.requests[0].body.stream, false);

      const r2 = await chat({ config: oaCfg, api: 'openai', model: 'm', messages, temperature: 0.1 });
      assert.equal(r2.content, 'from openai', 'think block stripped');
      assert.equal(oa.requests[0].url, '/v1/chat/completions');
      assert.deepEqual([r2.in_tok, r2.out_tok], [100, 20]);
    } finally {
      await ol.close();
      await oa.close();
    }
  });

  test('near-full context on ollama warns about truncation', async () => {
    const be = await fakeBackend({ usage: [990, 5], reply: () => 'ok' });
    try {
      const config = { ...DEFAULTS, base_url: be.url, num_ctx: 1000 };
      const r = await chat({ config, api: 'ollama', model: 'm', messages: [{ role: 'user', content: 'x' }], temperature: 0 });
      assert.match(r.warning, /probably truncated/);
    } finally {
      await be.close();
    }
  });

  test('concurrency limit is honoured', async () => {
    const be = await fakeBackend({ delay: 150, reply: () => 'ok' });
    try {
      const config = { ...DEFAULTS, base_url: be.url, concurrency: 2 };
      await Promise.all(Array.from({ length: 5 }, () => chat({
        config, api: 'ollama', model: 'm', messages: [{ role: 'user', content: 'x' }], temperature: 0,
      })));
      assert.equal(be.maxInFlight, 2);
    } finally {
      await be.close();
    }
  });

  test('helpers: code extraction and think stripping', () => {
    assert.equal(extractCode('Here:\n```js\nshort\n```\nand\n```\nlonger block\n```'), 'longer block\n');
    assert.equal(extractCode('plain code'), 'plain code\n');
    assert.equal(stripThink('<think>a\nb</think>\n\nanswer'), 'answer');
    assert.equal(stripThink('reasoning</think>answer'), 'answer');
  });
});

// ---------------------------------------------------------------------------

describe('offload', SUITE, () => {
  test('reads files and command output, jails paths, keeps head and tail when over budget', async () => {
    const be = await fakeBackend({ reply: () => 'The answer is 42.' });
    try {
      const root = await makeRepo();
      await write(path.join(root, 'notes.txt'), 'the magic number is 42\n');
      const ctx = await makeCtx(root, { LLW_BASE_URL: be.url, LLW_MODEL: 'test-model', LLW_NUM_CTX: '1000' });
      const out = await offload({
        task: 'What is the magic number?',
        files: ['notes.txt'],
        command: nodeCmd("let s='HEAD_MARK\\n';for(let i=0;i<2000;i++)s+='filler line '+i+'\\n';"
          + "process.stdout.write(s,()=>process.stderr.write('TAIL_MARK\\n'))"),
      }, ctx);
      assert.match(out, /^The answer is 42\./);
      assert.match(out, /omitted from the middle/);
      assert.match(out, /— test-model · [\d.]+s · 100 input tokens read locally$/);
      const prompt = be.requests[0].user;
      assert.match(prompt, /What is the magic number\?/);
      assert.match(prompt, /the magic number is 42/);
      assert.match(prompt, /HEAD_MARK/);
      assert.match(prompt, /TAIL_MARK/);
      assert.doesNotMatch(prompt, /filler line 1000\n/);
      assert.ok(prompt.length < 3000 + 1000);
      assert.match(be.requests[0].body.messages[0].content, /ONLY from that material/);

      await assert.rejects(offload({ task: 'q', files: ['../etc/passwd'] }, ctx), /outside the project root/);
    } finally {
      await be.close();
    }
  });

  test('writes a stats line per run', async () => {
    const be = await fakeBackend({ reply: () => 'ok' });
    try {
      const root = await makeRepo();
      const log = path.join(await tmpdir(), 'logs/runs.jsonl');
      const ctx = await makeCtx(root, { LLW_BASE_URL: be.url, LLW_MODEL: 'test-model', LLW_LOG_PATH: log, LLW_API: 'ollama' });
      await offload({ task: 'q', files: ['README.md'] }, ctx);
      const entry = JSON.parse((await fs.readFile(log, 'utf8')).trim());
      assert.equal(entry.tool, 'offload');
      assert.equal(entry.model, 'test-model');
      assert.equal(entry.api, 'ollama');
      assert.equal(entry.ok, true);
      assert.equal(entry.attempts, 1);
      assert.equal(entry.in_tok, 100);
      assert.equal(entry.out_tok, 20);
      assert.ok(typeof entry.ts === 'string' && typeof entry.ms === 'number');
    } finally {
      await be.close();
    }
  });
});

// ---------------------------------------------------------------------------

describe('research', SUITE, () => {
  test('htmlToText keeps main content, drops scripts, nav and footer, decodes entities', () => {
    const text = htmlToText(`<head><title>T</title><style>.a{}</style></head><body><nav>NAV</nav>
      <article><h2>Heading</h2><p>A &lt;b&gt; &amp; &#169; &#x41;</p><ul><li>one</li></ul>${'<p>filler words here</p>'.repeat(40)}</article>
      <footer>FOOT</footer><script>alert(1)</script></body>`);
    assert.match(text, /## Heading/);
    assert.match(text, /A <b> & © A/);
    assert.match(text, /- one/);
    assert.doesNotMatch(text, /NAV|FOOT|alert|\.a\{\}/);
  });

  test('searches, skips unreadable pages, dedupes, cites sources; page text stays out of the result', async () => {
    const web = await fakeWeb();
    const backend = await fakeBackend({ reply: () => 'Version 4.2 shipped on 2026-03-01 [1].' });
    try {
      const ctx = await makeCtx(await tmpdir(), { LLW_BASE_URL: backend.url, LLW_SEARCH_URL: `${web.url}/`, LLW_ALLOW_PRIVATE_URLS: 'true' });
      const out = await research({ question: 'When did 4.2 ship?', query: 'release 4.2', max_sources: 2 }, ctx);
      assert.deepEqual(web.searches, ['release 4.2']);
      assert.match(out, /Version 4\.2 shipped on 2026-03-01 \[1\]/);
      assert.match(out, /\[1\] Good & Proper — .*\/good/);
      assert.match(out, /\[2\] .*\/plain/);
      assert.match(out, /Unreadable, skipped: 3/);
      assert.match(out, /HTTP 404/);
      assert.match(out, /unsupported content-type application\/pdf/);
      assert.match(out, /no readable text/);
      assert.doesNotMatch(out, /detail detail/);
      const prompt = backend.requests[0].user;
      assert.match(prompt, /# Question\nWhen did 4\.2 ship\?/);
      assert.match(prompt, /SOURCE \[1\] Good & Proper/);
      assert.match(prompt, /- first item/);
      assert.doesNotMatch(prompt, /SECRET_SCRIPT|NAV_MENU|FOOTER_TEXT/);
      assert.equal((prompt.match(/\/good\n/g) || []).length, 1, 'duplicate result read once');
    } finally {
      await web.close();
      await backend.close();
    }
  });

  test('urls mode reads given pages without a search_url', async () => {
    const web = await fakeWeb();
    const backend = await fakeBackend({ reply: () => 'plain answer [1]' });
    try {
      const ctx = await makeCtx(await tmpdir(), { LLW_BASE_URL: backend.url, LLW_ALLOW_PRIVATE_URLS: 'true' });
      const out = await research({ question: 'q', urls: [`${web.url}/plain`] }, ctx);
      assert.match(out, /plain answer \[1\]/);
      assert.equal(web.searches.length, 0);
    } finally {
      await web.close();
      await backend.close();
    }
  });

  test('clear errors: no search_url, JSON disabled, nothing readable, bad urls', async () => {
    const ctx = await makeCtx(await tmpdir(), { LLW_ALLOW_PRIVATE_URLS: 'true' });
    await assert.rejects(research({ question: 'q' }, ctx), /No search_url configured.*SearXNG/s);
    await assert.rejects(research({ question: 'q', urls: ['file:///etc/passwd'] }, ctx), /http\(s\) URLs/);
    await assert.rejects(research({}, ctx), /"question" is required/);
    const web403 = await fakeWeb({ status: 403 });
    const web = await fakeWeb();
    try {
      await assert.rejects(research({ question: 'q' }, await makeCtx(await tmpdir(), { LLW_SEARCH_URL: web403.url })), /JSON output is disabled/);
      await assert.rejects(research({ question: 'q', urls: [`${web.url}/missing`] }, ctx), /Could not read any page/);
    } finally {
      await web403.close();
      await web.close();
    }
  });
});

describe('MCP stdio', SUITE, () => {
  let child;
  let pending;
  const responses = new Map();

  before(async () => {
    const home = await tmpdir('llw-home-');
    const entry = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/index.js');
    child = spawn(process.execPath, [entry], {
      env: baseEnv({ HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'), LLW_LOG_PATH: '' }),
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    let buf = '';
    child.stdout.setEncoding('utf8').on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const msg = JSON.parse(buf.slice(0, i));
        buf = buf.slice(i + 1);
        responses.set(msg.id, msg);
        pending?.();
      }
    });
  });

  after(() => child.kill());

  async function rpc(msg) {
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
    while (!responses.has(msg.id)) await new Promise((r) => { pending = r; });
    return responses.get(msg.id);
  }

  test('initialize, tools/list, unknown method, notifications', async () => {
    const init = await rpc({ id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {} } });
    assert.equal(init.result.protocolVersion, '2024-11-05');
    assert.deepEqual(init.result.capabilities, { tools: {} });
    assert.equal(init.result.serverInfo.name, 'local-llm-worker');
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    const list = await rpc({ id: 2, method: 'tools/list' });
    assert.deepEqual(list.result.tools.map((t) => t.name).sort(), ['configure', 'delegate', 'offload', 'research']);
    assert.deepEqual((await rpc({ id: 3, method: 'ping' })).result, {});
    assert.equal((await rpc({ id: 4, method: 'nope' })).error.code, -32601);
    const bad = await rpc({ id: 5, method: 'tools/call', params: { name: 'offload', arguments: {} } });
    assert.equal(bad.result.isError, true);
    assert.match(bad.result.content[0].text, /"task" is required/);
  });
});

describe('SessionStart hook', () => {
  const hook = path.join(path.dirname(fileURLToPath(import.meta.url)), '../hooks/session-start.mjs');
  async function runHook(extraEnv) {
    const home = await tmpdir('llw-home-');
    const env = baseEnv({ HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'), CLAUDE_PROJECT_DIR: home, ...extraEnv });
    delete env.LLW_AUTO_USE;
    Object.assign(env, extraEnv);
    return new Promise((resolve) => {
      const child = spawn(process.execPath, [hook], { env, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      child.stdout.on('data', (d) => { out += d; });
      child.on('close', (code) => resolve({ code, out }));
    });
  }

  test('default auto_use names offload and research, not delegate, and stays short', async () => {
    const r = await runHook({});
    assert.equal(r.code, 0);
    const ctx = JSON.parse(r.out).hookSpecificOutput;
    assert.equal(ctx.hookEventName, 'SessionStart');
    assert.match(ctx.additionalContext, /- offload:/);
    assert.match(ctx.additionalContext, /- research:/);
    assert.doesNotMatch(ctx.additionalContext, /- delegate:/);
    assert.ok(ctx.additionalContext.length < 600, 'it costs every session');
  });

  test('follows auto_use, and prints nothing when it is empty', async () => {
    const only = JSON.parse((await runHook({ LLW_AUTO_USE: 'delegate' })).out).hookSpecificOutput.additionalContext;
    assert.match(only, /- delegate:/);
    assert.doesNotMatch(only, /- offload:|- research:/);
    const none = await runHook({ LLW_AUTO_USE: '[]' });
    assert.equal(none.code, 0);
    assert.equal(none.out, '');
  });

  test('a broken config file does not break session start', async () => {
    const home = await tmpdir('llw-home-');
    await write(path.join(home, '.config/local-llm-worker/config.json'), '{ nope');
    const r = await runHook({ HOME: home, XDG_CONFIG_HOME: path.join(home, '.config') });
    assert.equal(r.code, 0);
    assert.match(JSON.parse(r.out).hookSpecificOutput.additionalContext, /- offload:/);
  });
});
