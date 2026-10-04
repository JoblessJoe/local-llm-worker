// Regression tests for the hardening plan: A1 known issues and A2 config review.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import dns from 'node:dns';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  loadConfig, configure, offload, delegate, chat, research, runShell, shellCommand, linkType,
  isPrivateAddress, DEFAULTS,
} from '../src/worker.js';
import {
  tmpdir, sh, write, makeRepo, fakeBackend, fakeWeb, makeCtx, TAP_CMD, nodeCmd, baseEnv,
  ADD_TEST, GOOD_ADD, worktrees,
  SUITE,
} from './helpers.js';

const fwd = (p) => p.replace(/\\/g, '/');

// ---------------------------------------------------------------------------
// A1.1 MCP progress notifications

describe('A1.1 progress notifications', SUITE, () => {
  function startServer(env) {
    const entry = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/index.js');
    const child = spawn(process.execPath, [entry], { env: baseEnv(env), stdio: ['pipe', 'pipe', 'inherit'] });
    const messages = [];
    let wake;
    let buf = '';
    child.stdout.setEncoding('utf8').on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        messages.push(JSON.parse(buf.slice(0, i)));
        buf = buf.slice(i + 1);
        wake?.();
      }
    });
    const send = (msg) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
    const waitFor = async (pred) => {
      while (!messages.some(pred)) await new Promise((r) => { wake = r; });
      return messages.find(pred);
    };
    return { child, messages, send, waitFor };
  }

  test('delegate sends increasing notifications/progress for the client\'s progressToken', async () => {
    const be = await fakeBackend({ reply: () => GOOD_ADD });
    const root = await makeRepo();
    await write(path.join(root, 'test/add.test.js'), ADD_TEST);
    const home = await tmpdir('llw-home-');
    const srv = startServer({
      HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'), LLW_LOG_PATH: '',
      LLW_BASE_URL: be.url, LLW_MODEL: 'test-model', CLAUDE_PROJECT_DIR: root,
    });
    try {
      srv.send({
        id: 1,
        method: 'tools/call',
        params: {
          name: 'delegate',
          _meta: { progressToken: 'tok-1' },
          arguments: { spec: 'add', target_file: 'src/add.js', test_command: TAP_CMD('test/add.test.js') },
        },
      });
      const res = await srv.waitFor((m) => m.id === 1);
      assert.match(res.result.content[0].text, /^PASS/);
      const progress = srv.messages.filter((m) => m.method === 'notifications/progress');
      assert.ok(progress.length >= 2, `got ${progress.length} progress notifications`);
      for (const p of progress) {
        assert.equal(p.params.progressToken, 'tok-1');
        assert.equal(typeof p.params.message, 'string');
        assert.equal(p.id, undefined, 'notifications carry no id');
      }
      const values = progress.map((p) => p.params.progress);
      assert.deepEqual(values, [...values].sort((a, b) => a - b));
      assert.equal(new Set(values).size, values.length, 'strictly increasing');
      assert.ok(progress.some((p) => /running tests/i.test(p.params.message)));
      assert.ok(srv.messages.indexOf(progress.at(-1)) < srv.messages.indexOf(res), 'no progress after the result');

      // Without a token: no notifications.
      const before = srv.messages.length;
      srv.send({ id: 2, method: 'tools/call', params: { name: 'offload', arguments: { task: 'q', files: ['README.md'] } } });
      await srv.waitFor((m) => m.id === 2);
      assert.equal(srv.messages.slice(before).filter((m) => m.method).length, 0);
    } finally {
      srv.child.kill();
      await be.close();
    }
  });
});

// ---------------------------------------------------------------------------
// A1.2 Windows

describe('A1.2 platform shell, junctions, process-tree kill', SUITE, () => {
  test('shellCommand uses cmd.exe on win32 and sh elsewhere', () => {
    const win = shellCommand('echo hi', 'win32');
    assert.match(path.basename(win.file).toLowerCase(), /^cmd(\.exe)?$/);
    assert.deepEqual(win.args, ['/d', '/s', '/c', '"echo hi"']);
    assert.equal(win.options.windowsVerbatimArguments, true);
    assert.equal(win.options.detached, false);
    const posix = shellCommand('echo hi', 'linux');
    assert.equal(posix.file, '/bin/sh');
    assert.deepEqual(posix.args, ['-c', 'echo hi']);
    assert.equal(posix.options.detached, true, 'own process group, so a timeout can kill it whole');
  });

  test('link_dirs are junctions on win32', () => {
    assert.equal(linkType('win32'), 'junction');
    assert.equal(linkType('darwin'), 'dir');
  });

  test('runShell uses the platform shell for real', async () => {
    const cmd = process.platform === 'win32' ? 'echo %OS%' : 'echo "$0"';
    const r = await runShell(cmd, { cwd: await tmpdir() });
    assert.equal(r.code, 0, r.output);
    assert.match(r.output, process.platform === 'win32' ? /Windows_NT/ : /sh/);
  });

  test('timeout kills the whole process tree', async () => {
    const dir = await tmpdir();
    const pidFile = fwd(path.join(dir, 'grandchild.pid'));
    // The child spawns a grandchild that shares its stdout and never exits.
    const js = "const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'});"
      + `require('fs').writeFileSync('${pidFile}',String(c.pid));setInterval(()=>{},1000)`;
    const started = Date.now();
    const r = await runShell(nodeCmd(js), { cwd: dir, timeout: 1500 });
    assert.equal(r.timedOut, true);
    assert.ok(Date.now() - started < 15000, `returned after ${Date.now() - started} ms`);
    const pid = Number(await fs.readFile(pidFile, 'utf8'));
    let alive = true;
    for (let i = 0; i < 50 && alive; i++) {
      try { process.kill(pid, 0); await new Promise((res) => setTimeout(res, 100)); } catch { alive = false; }
    }
    assert.equal(alive, false, 'grandchild was killed');
  });
});

// ---------------------------------------------------------------------------
// A1.3 orphaned worktrees

describe('A1.3 orphaned worktrees', SUITE, () => {
  test('delegate prunes missing and stale llw-* worktrees, keeps fresh ones', async () => {
    const be = await fakeBackend({ reply: () => GOOD_ADD });
    try {
      const root = await makeRepo();
      await write(path.join(root, 'test/add.test.js'), ADD_TEST);
      const mk = async () => {
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'llw-'));
        await sh(root, 'git', 'worktree', 'add', '--detach', dir, 'HEAD');
        return dir;
      };
      const gone = await mk();
      await fs.rm(gone, { recursive: true, force: true });
      const stale = await mk();
      const old = new Date(Date.now() - 25 * 3600 * 1000);
      await fs.utimes(stale, old, old);
      const fresh = await mk();
      const other = await fs.mkdtemp(path.join(await tmpdir(), 'mine-'));
      await sh(root, 'git', 'worktree', 'add', '--detach', other, 'HEAD');
      await fs.utimes(other, old, old);

      const ctx = await makeCtx(root, { LLW_BASE_URL: be.url, LLW_MODEL: 'test-model' });
      const out = await delegate({ spec: 'add', target_file: 'src/add.js', test_command: TAP_CMD('test/add.test.js') }, ctx);
      assert.match(out, /^PASS/, out);
      const names = (await worktrees(root)).map((w) => path.basename(w));
      assert.ok(!names.includes(path.basename(gone)), 'missing dir pruned');
      assert.ok(!names.includes(path.basename(stale)), 'stale llw-* removed');
      assert.ok(names.includes(path.basename(fresh)), 'fresh llw-* kept');
      assert.ok(names.includes(path.basename(other)), 'non-llw worktree untouched');
      await assert.rejects(fs.access(stale));
      await sh(root, 'git', 'worktree', 'remove', '--force', fresh);
      await sh(root, 'git', 'worktree', 'remove', '--force', other);
    } finally {
      await be.close();
    }
  });
});

// ---------------------------------------------------------------------------
// A1.4 large untracked files

describe('A1.4 mirroring caps', SUITE, () => {
  test('untracked files over 10 MB are skipped and reported', async () => {
    const be = await fakeBackend({ reply: () => 'export const x = 1;' });
    try {
      const root = await makeRepo();
      await write(path.join(root, 'big.bin'), Buffer.alloc(11 * 1024 * 1024));
      await write(path.join(root, 'small.txt'), 'small\n');
      const ctx = await makeCtx(root, { LLW_BASE_URL: be.url, LLW_MODEL: 'test-model' });
      const out = await delegate({
        spec: 'x',
        target_file: 'x.js',
        test_command: nodeCmd("const f=require('fs');process.exit(f.existsSync('small.txt')&&!f.existsSync('big.bin')?0:1)"),
      }, ctx);
      assert.match(out, /^PASS/, out);
      assert.match(out, /1 untracked file over 10 MB was not copied into the worktree/);
    } finally {
      await be.close();
    }
  });

  test('an untracked symlink to a directory is not followed', { skip: process.platform === 'win32' && 'symlinks need privileges' }, async () => {
    const be = await fakeBackend({ reply: () => 'export const x = 1;' });
    try {
      const root = await makeRepo();
      const outside = await tmpdir();
      await write(path.join(outside, 'inner/file.txt'), 'outside\n');
      await fs.symlink(outside, path.join(root, 'linked'), 'dir');
      const ctx = await makeCtx(root, { LLW_BASE_URL: be.url, LLW_MODEL: 'test-model' });
      const out = await delegate({
        spec: 'x',
        target_file: 'x.js',
        test_command: nodeCmd("const f=require('fs');process.exit(f.lstatSync('linked').isSymbolicLink()?0:1)"),
        apply: false,
      }, ctx);
      assert.match(out, /^PASS/, out);
      assert.equal(await fs.readFile(path.join(outside, 'inner/file.txt'), 'utf8'), 'outside\n');
      const kept = /passing file is at (\S+)/.exec(out)[1];
      await sh(root, 'git', 'worktree', 'remove', '--force', path.dirname(kept));
    } finally {
      await be.close();
    }
  });
});

// ---------------------------------------------------------------------------
// A1.5 max_tokens

describe('A1.5 max_tokens and length stops', SUITE, () => {
  test('an explicit limit is sent on both APIs', async () => {
    const ol = await fakeBackend({ kind: 'ollama', reply: () => 'ok' });
    const oa = await fakeBackend({ kind: 'openai', reply: () => 'ok' });
    try {
      const messages = [{ role: 'user', content: 'x' }];
      await chat({ config: { ...DEFAULTS, base_url: oa.url }, api: 'openai', model: 'm', messages, temperature: 0 });
      assert.equal(oa.requests[0].body.max_tokens, DEFAULTS.max_tokens);
      await chat({ config: { ...DEFAULTS, base_url: ol.url, max_tokens: 1234 }, api: 'ollama', model: 'm', messages, temperature: 0 });
      assert.equal(ol.requests[0].body.options.num_predict, 1234);
    } finally {
      await ol.close();
      await oa.close();
    }
  });

  for (const kind of ['openai', 'ollama']) {
    test(`${kind}: a length stop is reported, and delegate does not run the tests on cut-off code`, async () => {
      const be = await fakeBackend({ kind, reply: () => ({ content: '```js\nexport function add(a, b) {\n', truncated: true }) });
      try {
        const root = await makeRepo();
        const marker = fwd(path.join(await tmpdir(), 'ran.txt'));
        const ctx = await makeCtx(root, { LLW_BASE_URL: be.url, LLW_MODEL: 'test-model', LLW_API: kind, LLW_MAX_TOKENS: '64' });
        const out = await delegate({
          spec: 'add',
          target_file: 'src/add.js',
          test_command: nodeCmd(`require('fs').appendFileSync('${marker}','x');process.exit(1)`),
          max_attempts: 2,
        }, ctx);
        assert.match(out, /^FAIL · attempt 2\/2/);
        assert.match(out, /cut off at max_tokens \(64\)/);
        await assert.rejects(fs.access(marker), 'test command never ran');
        assert.match(be.requests[1].user, /cut off at max_tokens/);

        const off = await offload({ task: 'q', files: ['README.md'] }, ctx);
        assert.match(off, /cut off at max_tokens \(64\)/);
      } finally {
        await be.close();
      }
    });
  }
});

// ---------------------------------------------------------------------------
// A1.6 research SSRF

describe('A1.6 research refuses private page URLs', SUITE, () => {
  test('isPrivateAddress', () => {
    for (const a of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254',
      '0.0.0.0', '100.64.0.1', '::1', '::', 'fe80::1', 'fc00::1', 'fd12::1', '::ffff:127.0.0.1', '::ffff:7f00:1']) {
      assert.equal(isPrivateAddress(a), true, a);
    }
    for (const a of ['8.8.8.8', '172.32.0.1', '93.184.216.34', '2606:4700::1111', '::ffff:8.8.8.8']) {
      assert.equal(isPrivateAddress(a), false, a);
    }
  });

  test('loopback page URLs are refused unless allow_private_urls is set; the search endpoint stays allowed', async () => {
    const web = await fakeWeb();
    const backend = await fakeBackend({ reply: () => 'answer [1]' });
    try {
      const base = { LLW_BASE_URL: backend.url, LLW_SEARCH_URL: web.url };
      let ctx = await makeCtx(await tmpdir(), base);
      await assert.rejects(research({ question: 'q', urls: [`${web.url}/plain`] }, ctx), /private address/);
      await assert.rejects(research({ question: 'q', urls: [`http://localhost:${web.port}/plain`] }, ctx), /private address/);
      // Search on localhost works; the loopback results it returns are refused.
      await assert.rejects(research({ question: 'q' }, ctx), /Could not read any page[\s\S]*private address/);
      assert.equal(web.searches.length, 1);

      ctx = await makeCtx(await tmpdir(), { ...base, LLW_ALLOW_PRIVATE_URLS: 'true' });
      assert.match(await research({ question: 'q', urls: [`${web.url}/plain`] }, ctx), /answer \[1\]/);
    } finally {
      await web.close();
      await backend.close();
    }
  });

  test('a redirect to a private address is refused', async () => {
    const web = await fakeWeb({
      routes: {
        '/hop': (req, res, base) => { res.writeHead(302, { location: `${base}/plain` }); res.end(); },
      },
    });
    const backend = await fakeBackend({ reply: () => 'answer [1]' });
    try {
      // Pretend "localhost" is a public host; the redirect target 127.0.0.1 is not.
      const lookup = (host, opts, cb) => (host === 'localhost'
        ? cb(null, [{ address: '198.51.100.7', family: 4 }])
        : dns.lookup(host, opts, cb));
      const ctx = { ...(await makeCtx(await tmpdir(), { LLW_BASE_URL: backend.url })), lookup };
      const err = await research({ question: 'q', urls: [`http://localhost:${web.port}/hop`] }, ctx).catch((e) => e);
      assert.match(String(err), /redirect.*private address|private address.*redirect/i);
      assert.equal(backend.requests.length, 0);
    } finally {
      await web.close();
      await backend.close();
    }
  });
});

// ---------------------------------------------------------------------------
// A2 config review

describe('A2 config', SUITE, () => {
  test('keep_alive and headers are sent; header values and api_key are masked by configure', async () => {
    const be = await fakeBackend({ reply: (entry, n, req) => `auth=${req.headers['x-gateway-key']}` });
    try {
      const root = await makeRepo();
      const ctx = await makeCtx(root, {
        LLW_BASE_URL: be.url, LLW_MODEL: 'test-model', LLW_API: 'ollama', LLW_KEEP_ALIVE: '30m',
        LLW_HEADERS: '{"x-gateway-key":"hdr-secret"}', LLW_API_KEY: 'sk-secret',
      });
      const out = await offload({ task: 'q', files: ['README.md'] }, ctx);
      assert.match(out, /auth=hdr-secret/);
      assert.equal(be.requests[0].body.keep_alive, '30m');
      const report = await configure({}, ctx);
      assert.doesNotMatch(report, /hdr-secret|sk-secret/);
      const parsed = JSON.parse(report);
      assert.deepEqual(parsed.effective.headers, { 'x-gateway-key': '(set)' });
      assert.equal(parsed.effective.api_key, '(set)');
      assert.equal(parsed.effective.keep_alive, '30m');
      for (const key of ['max_tokens', 'keep_alive', 'headers', 'allow_private_urls']) {
        assert.ok(key in parsed.effective, `configure shows ${key}`);
      }
    } finally {
      await be.close();
    }
  });

  test('env parsing for every type', async () => {
    const root = await makeRepo();
    const good = await loadConfig(await makeCtx(root, {
      LLW_NUM_CTX: ' 4096 ', LLW_MAX_ATTEMPTS: '5', LLW_API: 'openai', LLW_LINK_DIRS: '["a b","c"]',
      LLW_ALLOW_PRIVATE_URLS: 'yes', LLW_KEEP_ALIVE: '-1', LLW_HEADERS: '{"a":"b"}', LLW_MODEL: 'm',
    }));
    assert.deepEqual(good.warnings, []);
    assert.equal(good.config.num_ctx, 4096);
    assert.equal(good.config.max_attempts, 5);
    assert.equal(good.config.api, 'openai');
    assert.deepEqual(good.config.link_dirs, ['a b', 'c']);
    assert.equal(good.config.allow_private_urls, true);
    assert.equal(good.config.keep_alive, -1);
    assert.deepEqual(good.config.headers, { a: 'b' });

    const bad = await loadConfig(await makeCtx(root, {
      LLW_NUM_CTX: '12abc', LLW_TIMEOUT_MS: '1e3', LLW_MAX_ATTEMPTS: '11', LLW_API: 'gpt', LLW_LINK_DIRS: '[1,2]',
      LLW_ALLOW_PRIVATE_URLS: 'maybe', LLW_KEEP_ALIVE: '5 minutes', LLW_HEADERS: '{bad', LLW_CONCURRENCY: '0',
    }));
    const w = bad.warnings.join('\n');
    for (const name of ['NUM_CTX', 'TIMEOUT_MS', 'MAX_ATTEMPTS', 'API', 'LINK_DIRS', 'ALLOW_PRIVATE_URLS', 'KEEP_ALIVE', 'HEADERS', 'CONCURRENCY']) {
      assert.match(w, new RegExp(`LLW_${name}: ignored`), name);
    }
    assert.equal(bad.config.num_ctx, DEFAULTS.num_ctx);
    assert.equal(bad.config.allow_private_urls, false);
  });

  test('bad JSON in a config file names the file', async () => {
    const root = await makeRepo();
    const ctx = await makeCtx(root);
    await write(path.join(root, '.local-llm-worker.json'), '{"model": ');
    await assert.rejects(configure({}, ctx), (err) => err.message.includes(path.join(root, '.local-llm-worker.json')) && /Invalid JSON/.test(err.message));
    await assert.rejects(offload({ task: 'q', files: ['README.md'] }, ctx), /Invalid JSON in .*\.local-llm-worker\.json/);
  });

  test('api_key never appears in errors, even when the backend echoes it', async () => {
    const be = await fakeBackend({
      reply: (entry, n, req) => (res) => {
        res.writeHead(401, { 'content-type': 'text/plain' });
        res.end(`bad credentials: ${req.headers.authorization}`);
      },
    });
    try {
      const root = await makeRepo();
      const ctx = await makeCtx(root, { LLW_BASE_URL: be.url, LLW_MODEL: 'm', LLW_API: 'ollama', LLW_API_KEY: 'sk-very-secret' });
      const err = await offload({ task: 'q', files: ['README.md'] }, ctx).catch((e) => e);
      assert.match(err.message, /HTTP 401/);
      assert.doesNotMatch(err.message, /sk-very-secret/);
      assert.match(err.message, /\(redacted\)/);
    } finally {
      await be.close();
    }
  });

  test('every config key is documented in the README', async () => {
    const readme = await fs.readFile(path.join(path.dirname(fileURLToPath(import.meta.url)), '../README.md'), 'utf8');
    for (const key of Object.keys(DEFAULTS)) assert.match(readme, new RegExp(`\\| \`${key}\` \\|`), key);
  });
});

// ---------------------------------------------------------------------------
// Found in real-hardware testing: fetch (undici) aborts a response whose headers
// take over 300 s, before timeout_ms could fire. A non-streamed answer from a slow,
// thinking or queued model sends its headers only at the end.

describe('chat transport', SUITE, () => {
  test('LLM calls do not go through fetch, so its 300 s headers timeout cannot apply', async () => {
    const backend = await fakeBackend({ reply: () => 'ok', delay: 50 });
    const realFetch = globalThis.fetch;
    globalThis.fetch = () => { throw new Error('fetch must not be used for chat'); };
    try {
      const ctx = await makeCtx(await tmpdir(), { LLW_BASE_URL: backend.url });
      const { config } = await loadConfig(ctx);
      for (const api of ['ollama', 'openai']) {
        const res = await chat({ config, api, model: 'test-model', messages: [{ role: 'user', content: 'hi' }], temperature: 0 });
        assert.equal(res.content, 'ok', api);
        assert.equal(res.in_tok, 100, api);
      }
    } finally {
      globalThis.fetch = realFetch;
      await backend.close();
    }
  });

  test('timeout_ms still applies', async () => {
    const backend = await fakeBackend({ reply: () => 'late', delay: 1000 });
    try {
      const ctx = await makeCtx(await tmpdir(), { LLW_BASE_URL: backend.url, LLW_TIMEOUT_MS: '100' });
      const { config } = await loadConfig(ctx);
      await assert.rejects(
        chat({ config, api: 'ollama', model: 'test-model', messages: [{ role: 'user', content: 'hi' }], temperature: 0 }),
        /Backend request failed: .*timed out after 100 ms/,
      );
    } finally {
      await backend.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Found in real-hardware testing: a material budget of num_ctx × 3 chars plus
// max_tokens did not fit, Ollama silently cut the prompt to half the context, and
// the question at the top was lost.

describe('input budget and silent truncation', SUITE, () => {
  test('material budget leaves room for max_tokens, the question is repeated after it, and a backend cut is reported', async () => {
    const be = await fakeBackend({ reply: () => 'answer', usage: [1000, 5] });
    try {
      const root = await makeRepo();
      await write(path.join(root, 'big.log'), 'x'.repeat(50000));
      const ctx = await makeCtx(root, { LLW_BASE_URL: be.url, LLW_MODEL: 'test-model', LLW_NUM_CTX: '10000', LLW_MAX_TOKENS: '2000' });
      const out = await offload({ task: 'FIND_ME?', files: ['big.log'] }, ctx);
      assert.match(out, /over the \d+-character budget/);
      const prompt = be.requests[0].user;
      assert.match(prompt, /^## Question\nFIND_ME\?/);
      assert.match(prompt, /## Question \(repeated\)\nFIND_ME\?$/);
      assert.match(out, /model read only 1000; the backend truncated the input/);
    } finally {
      await be.close();
    }
  });
});
