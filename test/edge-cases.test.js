// Adversarial edge cases (hardening plan A3).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { offload, delegate, chat, research, stripThink, DEFAULTS } from '../src/worker.js';
import {
  tmpdir, sh, write, makeRepo, fakeBackend, fakeWeb, makeCtx, TAP_CMD, nodeCmd, baseEnv,
  ADD_TEST, GOOD_ADD, BAD_ADD, worktrees,
  SUITE,
} from './helpers.js';

const PASS_CMD = nodeCmd('process.exit(0)');

async function withBackend(opts, fn) {
  const be = await fakeBackend(opts);
  try {
    return await fn(be);
  } finally {
    await be.close();
  }
}

// ---------------------------------------------------------------------------

describe('delegate edge cases', SUITE, () => {
  test('target in a new nested directory', () => withBackend({ reply: () => 'export const x = 1;' }, async (be) => {
    const root = await makeRepo();
    const ctx = await makeCtx(root, { LLW_BASE_URL: be.url, LLW_MODEL: 'm' });
    const out = await delegate({ spec: 'x', target_file: 'a/b/c/new.js', test_command: PASS_CMD }, ctx);
    assert.match(out, /^PASS .* a\/b\/c\/new\.js .* applied: yes/);
    assert.equal(await fs.readFile(path.join(root, 'a/b/c/new.js'), 'utf8'), 'export const x = 1;\n');
  }));

  test('target path with spaces and unicode', () => withBackend({ reply: () => 'export const x = 1;' }, async (be) => {
    const root = await makeRepo();
    const ctx = await makeCtx(root, { LLW_BASE_URL: be.url, LLW_MODEL: 'm' });
    const out = await delegate({
      spec: 'x',
      target_file: 'my dir/grüße ü.js',
      test_command: nodeCmd("process.exit(require('fs').existsSync('my dir/gr\\u00fc\\u00dfe \\u00fc.js')?0:1)"),
    }, ctx);
    assert.match(out, /^PASS .* applied: yes/, out);
    assert.equal(await fs.readFile(path.join(root, 'my dir/grüße ü.js'), 'utf8'), 'export const x = 1;\n');
    assert.deepEqual(await worktrees(root), [root]);
  }));

  test('target that is a directory is refused up front', async () => {
    const root = await makeRepo();
    await fs.mkdir(path.join(root, 'src'));
    const ctx = await makeCtx(root, { LLW_BASE_URL: 'http://127.0.0.1:9', LLW_MODEL: 'm' });
    await assert.rejects(delegate({ spec: 's', target_file: 'src', test_command: PASS_CMD }, ctx), /is a directory/);
    assert.deepEqual(await worktrees(root), [root]);
  });

  test('target that is a symlink out of the repo is refused', async (t) => {
    const root = await makeRepo();
    const outside = path.join(await tmpdir(), 'victim.js');
    await write(outside, 'original\n');
    try { await fs.symlink(outside, path.join(root, 'link.js'), 'file'); } catch { return t.skip('no symlink privilege'); }
    const ctx = await makeCtx(root, { LLW_BASE_URL: 'http://127.0.0.1:9', LLW_MODEL: 'm' });
    await assert.rejects(delegate({ spec: 's', target_file: 'link.js', test_command: PASS_CMD }, ctx), /outside the project root/);
    assert.equal(await fs.readFile(outside, 'utf8'), 'original\n');
    return undefined;
  });

  test('repo on a detached HEAD', () => withBackend({ reply: () => GOOD_ADD }, async (be) => {
    const root = await makeRepo();
    await sh(root, 'git', 'checkout', '-q', '--detach');
    await write(path.join(root, 'test/add.test.js'), ADD_TEST);
    const ctx = await makeCtx(root, { LLW_BASE_URL: be.url, LLW_MODEL: 'm' });
    const out = await delegate({ spec: 'add', target_file: 'src/add.js', test_command: TAP_CMD('test/add.test.js') }, ctx);
    assert.match(out, /^PASS .* applied: yes/, out);
  }));

  test('repo with a (modified) submodule', () => withBackend({ reply: () => 'export const x = 1;' }, async (be) => {
    const lib = await makeRepo();
    const root = await makeRepo();
    await sh(root, 'git', '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', lib, 'lib');
    await sh(root, 'git', 'commit', '-q', '-m', 'submodule');
    await write(path.join(root, 'lib/README.md'), 'changed inside the submodule\n');
    const ctx = await makeCtx(root, { LLW_BASE_URL: be.url, LLW_MODEL: 'm' });
    const out = await delegate({ spec: 'x', target_file: 'src/x.js', test_command: PASS_CMD }, ctx);
    assert.match(out, /^PASS .* applied: yes/, out);
    assert.deepEqual(await worktrees(root), [root]);
  }));

  test('dirty file deleted mid-run', async () => {
    let root;
    await withBackend({
      reply: async () => {
        await fs.rm(path.join(root, 'dirty.txt'), { force: true });
        await fs.rm(path.join(root, 'untracked.txt'), { force: true });
        return 'export const x = 1;';
      },
    }, async (be) => {
      root = await makeRepo();
      await write(path.join(root, 'dirty.txt'), 'v1\n');
      await sh(root, 'git', 'add', '.');
      await sh(root, 'git', 'commit', '-q', '-m', 'dirty');
      await write(path.join(root, 'dirty.txt'), 'v2\n');
      await write(path.join(root, 'untracked.txt'), 'u\n');
      const ctx = await makeCtx(root, { LLW_BASE_URL: be.url, LLW_MODEL: 'm' });
      const out = await delegate({ spec: 'x', target_file: 'src/x.js', test_command: PASS_CMD }, ctx);
      assert.match(out, /^PASS .* applied: yes/, out);
      await assert.rejects(fs.access(path.join(root, 'dirty.txt')), 'the user\'s deletion stands');
    });
  });

  test('a hanging test command is killed at test_timeout_ms', () => withBackend({ reply: () => 'export const x = 1;' }, async (be) => {
    const root = await makeRepo();
    const ctx = await makeCtx(root, { LLW_BASE_URL: be.url, LLW_MODEL: 'm', LLW_TEST_TIMEOUT_MS: '1000' });
    const started = Date.now();
    const out = await delegate({
      spec: 'x', target_file: 'x.js', test_command: nodeCmd('setInterval(()=>{},1000)'), max_attempts: 1,
    }, ctx);
    assert.match(out, /^FAIL · attempt 1\/1/);
    assert.match(out, /timed out after 1000 ms/);
    assert.ok(Date.now() - started < 15000);
    await sh(root, 'git', 'worktree', 'remove', '--force', /Worktree kept: (\S+)/.exec(out)[1]);
  }));

  test('a test command that prints 50 MB', () => withBackend({ reply: () => 'export const x = 1;' }, async (be) => {
    const root = await makeRepo();
    const ctx = await makeCtx(root, { LLW_BASE_URL: be.url, LLW_MODEL: 'm' });
    const out = await delegate({
      spec: 'x',
      target_file: 'x.js',
      test_command: nodeCmd("const s='Error '+'x'.repeat(1048570)+'\\n';for(let i=0;i<50;i++)process.stdout.write(s);process.exitCode=1"),
      max_attempts: 1,
    }, ctx);
    assert.match(out, /^FAIL · attempt 1\/1/);
    assert.ok(out.length < 4000, `verdict stays small (${out.length} chars)`);
    await sh(root, 'git', 'worktree', 'remove', '--force', /Worktree kept: (\S+)/.exec(out)[1]);
  }));

  test('model returns empty, then prose only, then several fenced blocks', () => withBackend({
    reply: (req, n) => ['', 'I would write an add function.', `\`\`\`\nnote\n\`\`\`\n${GOOD_ADD}`][n - 1],
  }, async (be) => {
    const root = await makeRepo();
    await write(path.join(root, 'test/add.test.js'), ADD_TEST);
    const ctx = await makeCtx(root, { LLW_BASE_URL: be.url, LLW_MODEL: 'm' });
    const out = await delegate({ spec: 'add', target_file: 'src/add.js', test_command: TAP_CMD('test/add.test.js') }, ctx);
    assert.match(out, /^PASS · attempt 3\/3/, out);
    assert.match(await fs.readFile(path.join(root, 'src/add.js'), 'utf8'), /return a \+ b/);
  }));

  test('max_attempts is clamped to 1..10', () => withBackend({ reply: () => BAD_ADD }, async (be) => {
    const root = await makeRepo();
    await write(path.join(root, 'test/add.test.js'), ADD_TEST);
    const ctx = await makeCtx(root, { LLW_BASE_URL: be.url, LLW_MODEL: 'm' });
    const args = { spec: 'add', target_file: 'src/add.js', test_command: nodeCmd('process.exit(1)') };
    for (const [given, want] of [[0, '1/1'], [-5, '1/1'], [99, '10/10'], [2.5, '3/3'], ['4', '3/3']]) {
      const out = await delegate({ ...args, max_attempts: given }, ctx);
      assert.match(out, new RegExp(`^FAIL · attempt ${want}`), `max_attempts ${given}`);
      await sh(root, 'git', 'worktree', 'remove', '--force', /Worktree kept: (\S+)/.exec(out)[1]);
    }
  }));

  test('8 parallel delegates to the same target: exactly one applies, the others report a conflict', () => withBackend({
    reply: (req, n) => `export const v = ${n};`,
  }, async (be) => {
    const root = await makeRepo();
    const ctx = await makeCtx(root, { LLW_BASE_URL: be.url, LLW_MODEL: 'm', LLW_CONCURRENCY: '8' });
    const outs = await Promise.all(Array.from({ length: 8 }, () => delegate({
      spec: 'v', target_file: 'src/v.js', test_command: PASS_CMD,
    }, ctx)));
    const applied = outs.filter((o) => /applied: yes/.test(o));
    const conflicts = outs.filter((o) => /changed in the checkout during the run/.test(o));
    assert.equal(applied.length, 1, outs.join('\n---\n'));
    assert.equal(conflicts.length, 7);
    for (const o of conflicts) await sh(root, 'git', 'worktree', 'remove', '--force', /Worktree kept: (\S+)/.exec(o)[1]);
    assert.deepEqual(await worktrees(root), [root]);
  }));
});

// ---------------------------------------------------------------------------

describe('offload edge cases', SUITE, () => {
  test('binary file is refused with a clear error', async () => {
    const root = await makeRepo();
    await write(path.join(root, 'blob.bin'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0x0d, 0xff]));
    const ctx = await makeCtx(root, { LLW_BASE_URL: 'http://127.0.0.1:9', LLW_MODEL: 'm' });
    await assert.rejects(offload({ task: 'q', files: ['blob.bin'] }, ctx), /"blob\.bin" looks like a binary file/);
  });

  test('non-UTF-8 file is decoded as Latin-1', () => withBackend({ reply: () => 'ok' }, async (be) => {
    const root = await makeRepo();
    await write(path.join(root, 'latin1.txt'), Buffer.from('caf\xe9 cr\xe8me\n', 'latin1'));
    const ctx = await makeCtx(root, { LLW_BASE_URL: be.url, LLW_MODEL: 'm' });
    await offload({ task: 'q', files: ['latin1.txt'] }, ctx);
    assert.match(be.requests[0].user, /café crème/);
  }));

  test('missing file', async () => {
    const root = await makeRepo();
    const ctx = await makeCtx(root, { LLW_BASE_URL: 'http://127.0.0.1:9', LLW_MODEL: 'm' });
    await assert.rejects(offload({ task: 'q', files: ['nope.txt'] }, ctx), /Cannot read "nope\.txt"/);
  });

  test('symlink pointing outside the root is refused', async (t) => {
    const root = await makeRepo();
    const secret = path.join(await tmpdir(), 'secret.txt');
    await write(secret, 'TOP SECRET\n');
    try { await fs.symlink(secret, path.join(root, 'innocent.txt'), 'file'); } catch { return t.skip('no symlink privilege'); }
    await withBackend({ reply: () => 'ok' }, async (be) => {
      const ctx = await makeCtx(root, { LLW_BASE_URL: be.url, LLW_MODEL: 'm' });
      await assert.rejects(offload({ task: 'q', files: ['innocent.txt'] }, ctx), /outside the project root/);
      assert.equal(be.requests.length, 0);
    });
    return undefined;
  });

  test('a hanging command is killed and the timeout is reported', () => withBackend({ reply: () => 'ok' }, async (be) => {
    const root = await makeRepo();
    const ctx = await makeCtx(root, { LLW_BASE_URL: be.url, LLW_MODEL: 'm', LLW_TEST_TIMEOUT_MS: '1000' });
    await offload({ task: 'q', command: nodeCmd("console.log('partial');setInterval(()=>{},1000)") }, ctx);
    assert.match(be.requests[0].user, /timed out after 1000 ms/);
    assert.match(be.requests[0].user, /partial/);
  }));

  test('empty material', () => withBackend({ reply: () => 'nothing there' }, async (be) => {
    const root = await makeRepo();
    await write(path.join(root, 'empty.txt'), '');
    const ctx = await makeCtx(root, { LLW_BASE_URL: be.url, LLW_MODEL: 'm' });
    await assert.rejects(offload({ task: 'q', files: [] }, ctx), /Give "files" and\/or "command"/);
    await assert.rejects(offload({ task: 'q', command: '' }, ctx), /Give "files" and\/or "command"/);
    assert.match(await offload({ task: 'q', files: ['empty.txt'] }, ctx), /^nothing there/);
    assert.match(be.requests[0].user, /### File: empty\.txt\n\(empty file\)/);
  }));
});

// ---------------------------------------------------------------------------

describe('research edge cases', SUITE, () => {
  const long = (w) => `${w} `.repeat(100);

  async function setup(routes, fn) {
    const web = await fakeWeb({ routes });
    const backend = await fakeBackend({ reply: () => 'answer [1]' });
    try {
      const ctx = await makeCtx(await tmpdir(), {
        LLW_BASE_URL: backend.url, LLW_SEARCH_URL: web.url, LLW_ALLOW_PRIVATE_URLS: 'true',
      });
      return await fn({ web, backend, ctx });
    } finally {
      await web.close();
      await backend.close();
    }
  }

  test('redirects are followed, loops stop', () => setup({
    '/hop': (req, res, base) => { res.writeHead(301, { location: `${base}/plain` }); res.end(); },
    '/loop': (req, res) => { res.writeHead(302, { location: '/loop' }); res.end(); },
  }, async ({ web, backend, ctx }) => {
    assert.match(await research({ question: 'q', urls: [`${web.url}/hop`] }, ctx), /answer \[1\]/);
    assert.match(backend.requests[0].user, /Plain text page/);
    await assert.rejects(research({ question: 'q', urls: [`${web.url}/loop`] }, ctx), /more than 5 redirects/);
  }));

  test('gzip, chunked response', () => setup({
    '/gz': (req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': 'gzip' }); // no length: chunked
      const gz = zlib.gzipSync(`GZIP_MARKER ${long('zipped')}`);
      res.write(gz.subarray(0, 10));
      setTimeout(() => res.end(gz.subarray(10)), 20);
    },
  }, async ({ web, backend, ctx }) => {
    await research({ question: 'q', urls: [`${web.url}/gz`] }, ctx);
    assert.match(backend.requests[0].user, /GZIP_MARKER zipped zipped/);
  }));

  test('a 6 MB page is read up to the 5 MB cap', () => setup({
    '/huge': (req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(`HEAD_MARKER ${'y'.repeat(6 * 1024 * 1024)}`);
    },
  }, async ({ web, ctx }) => {
    const out = await research({ question: 'q', urls: [`${web.url}/huge`] }, ctx);
    const chars = Number(/\((\d+) chars, truncated\)/.exec(out)[1]);
    assert.ok(chars <= 5 * 1024 * 1024, `${chars} chars`);
  }));

  test('charset=iso-8859-1 is decoded', () => setup({
    '/latin': (req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=iso-8859-1' });
      res.end(Buffer.from(`<html><body><main><p>Caf\xe9 cr\xe8me br\xfbl\xe9e. ${long('texte')}</p></main></body></html>`, 'latin1'));
    },
    '/meta': (req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(Buffer.from(`<html><head><meta charset="windows-1252"></head><body><p>Na\xefve \x93quotes\x94. ${long('mot')}</p></body></html>`, 'latin1'));
    },
  }, async ({ web, backend, ctx }) => {
    await research({ question: 'q', urls: [`${web.url}/latin`] }, ctx);
    assert.match(backend.requests[0].user, /Café crème brûlée\./);
    await research({ question: 'q', urls: [`${web.url}/meta`] }, ctx);
    assert.match(backend.requests[1].user, /Naïve “quotes”\./);
  }));

  test('SearXNG returning malformed JSON', () => setup({
    '/search': (req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"results": [ oops'); },
  }, async ({ ctx }) => {
    await assert.rejects(research({ question: 'q' }, ctx), /SearXNG at .* returned invalid JSON/);
  }));

  test('all pages failing', () => setup({}, async ({ web, backend, ctx }) => {
    await assert.rejects(
      research({ question: 'q', urls: [`${web.url}/missing`, `${web.url}/binary`, `${web.url}/empty`] }, ctx),
      /Could not read any page:\n- .*HTTP 404\n- .*unsupported content-type.*\n- .*no readable text/,
    );
    assert.equal(backend.requests.length, 0);
  }));

  test('duplicate URLs are read once', () => setup({}, async ({ web, backend, ctx }) => {
    const out = await research({ question: 'q', urls: [`${web.url}/plain`, `${web.url}/plain`] }, ctx);
    assert.doesNotMatch(out, /\[2\]/);
    assert.equal((backend.requests[0].user.match(/SOURCE \[/g) || []).length, 1);
  }));
});

// ---------------------------------------------------------------------------

describe('backend edge cases', SUITE, () => {
  const messages = [{ role: 'user', content: 'x' }];
  const raw = (fn) => () => fn;

  for (const api of ['ollama', 'openai']) {
    test(`${api}: HTTP 500, non-JSON body, reset mid-response, slow first byte`, async () => {
      const cases = {
        500: raw((res) => { res.writeHead(500, { 'content-type': 'text/plain' }); res.end('model crashed'); }),
        html: raw((res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html>proxy login</html>'); }),
        reset: raw((res) => {
          res.writeHead(200, { 'content-type': 'application/json', 'content-length': '1000' });
          res.write('{"message": {"content": "par');
          setTimeout(() => res.socket.destroy(), 20);
        }),
        slow: raw((res) => { setTimeout(() => { res.writeHead(200); res.end('{}'); }, 2000); }),
      };
      let which;
      const be = await fakeBackend({ kind: api, reply: (...a) => cases[which](...a) });
      try {
        const config = { ...DEFAULTS, base_url: be.url, timeout_ms: 300 };
        which = 500;
        await assert.rejects(chat({ config, api, model: 'm', messages, temperature: 0 }), /returned HTTP 500: model crashed/);
        which = 'html';
        await assert.rejects(chat({ config, api, model: 'm', messages, temperature: 0 }), /returned non-JSON: <html>proxy login/);
        which = 'reset';
        await assert.rejects(chat({ config, api, model: 'm', messages, temperature: 0 }), /Backend request failed: POST/);
        which = 'slow';
        await assert.rejects(chat({ config, api, model: 'm', messages, temperature: 0 }), /timed out after 300 ms/);
      } finally {
        await be.close();
      }
    });
  }

  test('Ollama <think> without a closing tag yields no answer text, not the reasoning', () => withBackend({
    reply: () => '<think>Let me reason about this for a very long time and never close the tag',
  }, async (be) => {
    assert.equal(stripThink('<think>unfinished reasoning'), '');
    assert.equal(stripThink('  <think>unfinished\nreasoning'), '');
    assert.equal(stripThink('const tag = "<think>";'), 'const tag = "<think>";', 'a literal tag in code stays');
    const r = await chat({ config: { ...DEFAULTS, base_url: be.url }, api: 'ollama', model: 'm', messages, temperature: 0 });
    assert.equal(r.content, '');
    const root = await makeRepo();
    const out = await offload({ task: 'q', files: ['README.md'] }, await makeCtx(root, { LLW_BASE_URL: be.url, LLW_MODEL: 'm', LLW_API: 'ollama' }));
    assert.match(out, /^\(empty answer\)/);
  }));
});

// ---------------------------------------------------------------------------

describe('MCP stdio edge cases', SUITE, () => {
  const entry = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/index.js');

  async function server(extraEnv = {}) {
    const home = await tmpdir('llw-home-');
    const child = spawn(process.execPath, [entry], {
      env: baseEnv({ HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'), LLW_LOG_PATH: '', ...extraEnv }),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const lines = [];
    let wake;
    let buf = '';
    child.stdout.setEncoding('utf8').on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        lines.push(buf.slice(0, i));
        buf = buf.slice(i + 1);
        wake?.();
      }
    });
    child.stderr.resume();
    const exited = new Promise((r) => child.on('exit', (code) => r(code)));
    const parsed = () => lines.map((l) => JSON.parse(l));
    const waitFor = async (pred) => {
      for (;;) {
        const hit = parsed().find(pred);
        if (hit) return hit;
        await new Promise((r) => { wake = r; });
      }
    };
    const send = (msg) => child.stdin.write(`${typeof msg === 'string' ? msg : JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`);
    return { child, lines, parsed, waitFor, send, exited };
  }

  test('malformed line gets a parse error and the server keeps going', async () => {
    const s = await server();
    try {
      s.send('{"jsonrpc": "2.0", "id": 1, "method": ');
      const err = await s.waitFor((m) => m.error?.code === -32700);
      assert.equal(err.id, null);
      s.send({ id: 2, method: 'ping' });
      assert.deepEqual((await s.waitFor((m) => m.id === 2)).result, {});
    } finally {
      s.child.kill();
    }
  });

  test('20 concurrent calls all get their own answer', () => withBackend({ delay: 100, reply: (req) => `echo:${/## Question\n(\S+)/.exec(req.user)[1]}` }, async (be) => {
    const root = await makeRepo();
    const s = await server({ LLW_BASE_URL: be.url, LLW_MODEL: 'm', LLW_CONCURRENCY: '20', CLAUDE_PROJECT_DIR: root });
    try {
      for (let i = 1; i <= 20; i++) {
        s.send({ id: i, method: 'tools/call', params: { name: 'offload', arguments: { task: `q${i}`, files: ['README.md'] } } });
      }
      for (let i = 1; i <= 20; i++) {
        const r = await s.waitFor((m) => m.id === i);
        assert.match(r.result.content[0].text, new RegExp(`^echo:q${i}\\n`));
      }
      assert.ok(be.maxInFlight > 1, 'calls ran concurrently');
    } finally {
      s.child.kill();
    }
  }));

  test('a request in flight when stdin closes is still answered, then the server exits', () => withBackend({ delay: 300, reply: () => 'late answer' }, async (be) => {
    const root = await makeRepo();
    const s = await server({ LLW_BASE_URL: be.url, LLW_MODEL: 'm', CLAUDE_PROJECT_DIR: root });
    s.send({ id: 1, method: 'tools/call', params: { name: 'offload', arguments: { task: 'q', files: ['README.md'] } } });
    s.child.stdin.end();
    const r = await s.waitFor((m) => m.id === 1);
    assert.match(r.result.content[0].text, /^late answer/);
    assert.equal(await s.exited, 0);
  }));

  test('huge argument payload', () => withBackend({ reply: (req) => `got ${req.user.length}` }, async (be) => {
    const root = await makeRepo();
    const s = await server({ LLW_BASE_URL: be.url, LLW_MODEL: 'm', CLAUDE_PROJECT_DIR: root, LLW_NUM_CTX: '1000' });
    try {
      s.send({ id: 1, method: 'tools/call', params: { name: 'offload', arguments: { task: 'z'.repeat(8 * 1024 * 1024), files: ['README.md'] } } });
      const r = await s.waitFor((m) => m.id === 1);
      assert.equal(r.result.isError, undefined, JSON.stringify(r).slice(0, 300));
    } finally {
      s.child.kill();
    }
  }));

  test('only JSON-RPC on stdout, even when a tool throws or a command prints', () => withBackend({ reply: () => 'ok' }, async (be) => {
    const root = await makeRepo();
    const s = await server({ LLW_BASE_URL: be.url, LLW_MODEL: 'm', CLAUDE_PROJECT_DIR: root, LLW_LOG_PATH: path.join(root, 'README.md', 'runs.jsonl') });
    try {
      s.send({ id: 1, method: 'tools/call', params: { name: 'offload', arguments: { task: 'q', files: ['missing.txt'] } } });
      s.send({ id: 2, method: 'tools/call', params: { name: 'offload', arguments: { task: 'q', command: nodeCmd("console.log('STDOUT_NOISE');console.error('STDERR_NOISE')") } } });
      s.send({ id: 3, method: 'tools/call', params: { name: 'delegate', arguments: { spec: 's', target_file: '../escape.js', test_command: 'x' } } });
      s.send({ id: 4, method: 'tools/call', params: { name: 'nope', arguments: {} } });
      s.send({ id: 5, method: 'tools/call', params: null });
      for (const id of [1, 2, 3, 4, 5]) await s.waitFor((m) => m.id === id);
      for (const line of s.lines) {
        const msg = JSON.parse(line);
        assert.equal(msg.jsonrpc, '2.0', line.slice(0, 200));
      }
      assert.equal(s.parsed().find((m) => m.id === 1).result.isError, true);
      assert.equal(s.parsed().find((m) => m.id === 3).result.isError, true);
    } finally {
      s.child.kill();
    }
  }));
});
