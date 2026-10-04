// Shared fixtures: temp repos, a fake LLM backend and a fake web.

import { after } from 'node:test';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { run } from '../src/worker.js';

const tmpRoots = [];

export async function tmpdir(prefix = 'llw-test-') {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
  tmpRoots.push(dir);
  return dir;
}

after(async () => {
  for (const d of tmpRoots) {
    // Worktrees a test kept (FAIL, conflict, orphan fixtures) live outside the repo dir.
    const r = await run('git', ['worktree', 'list', '--porcelain'], { cwd: d });
    if (r.code === 0) {
      const extra = r.stdout.split('\n').filter((l) => l.startsWith('worktree ')).slice(1).map((l) => l.slice(9));
      for (const wt of extra) await fs.rm(wt, { recursive: true, force: true });
    }
    await fs.rm(d, { recursive: true, force: true });
  }
});

export async function sh(cwd, ...args) {
  const r = await run(args[0], args.slice(1), { cwd });
  if (r.code !== 0) throw new Error(`${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
}

export async function write(file, content) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content);
}

export async function makeRepo() {
  const root = await tmpdir('llw-repo-');
  await sh(root, 'git', 'init', '-q');
  await sh(root, 'git', 'config', 'user.email', 'test@example.com');
  await sh(root, 'git', 'config', 'user.name', 'Test');
  await sh(root, 'git', 'config', 'commit.gpgsign', 'false');
  await write(path.join(root, 'package.json'), '{"type":"module"}\n');
  await write(path.join(root, 'README.md'), 'fixture\n');
  await sh(root, 'git', 'add', '.');
  await sh(root, 'git', 'commit', '-q', '-m', 'init');
  return root;
}

// Fake LLM backend answering both the Ollama and the OpenAI-compatible API.
export async function fakeBackend({ kind = 'ollama', models = ['test-model'], reply, delay = 0, usage = [100, 20] } = {}) {
  const state = { requests: [], inFlight: 0, maxInFlight: 0 };
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : null;
    const json = (status, data) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(data));
    };
    const url = req.url;
    if (url === '/api/version') {
      return kind === 'ollama' ? json(200, { version: '0.0.0-fake' }) : json(404, { error: 'not found' });
    }
    if (url === '/api/tags' && kind === 'ollama') return json(200, { models: models.map((name) => ({ name })) });
    if (url === '/v1/models') return json(200, { data: models.map((id) => ({ id })) });
    if ((url === '/api/chat' && kind === 'ollama') || url === '/v1/chat/completions') {
      state.inFlight++;
      state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
      const entry = { url, body, user: body.messages.find((m) => m.role === 'user').content };
      state.requests.push(entry);
      try {
        if (delay) await new Promise((r) => setTimeout(r, delay));
        // reply returns the content, or {content, truncated} to report a length stop,
        // or a function that writes the raw response itself.
        const out = await reply(entry, state.requests.length, req);
        if (typeof out === 'function') return out(res);
        const { content, truncated } = typeof out === 'object' && out !== null ? out : { content: out };
        if (url === '/api/chat') {
          json(200, {
            message: { role: 'assistant', content },
            done_reason: truncated ? 'length' : 'stop',
            prompt_eval_count: usage[0],
            eval_count: usage[1],
          });
        } else {
          json(200, {
            choices: [{ message: { role: 'assistant', content }, finish_reason: truncated ? 'length' : 'stop' }],
            usage: { prompt_tokens: usage[0], completion_tokens: usage[1] },
          });
        }
      } finally {
        state.inFlight--;
      }
      return undefined;
    }
    return json(404, { error: `no route ${url}` });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  state.port = server.address().port;
  state.url = `http://127.0.0.1:${state.port}`;
  state.close = () => new Promise((r) => { server.close(r); server.closeAllConnections?.(); });
  return state;
}

export async function makeCtx(cwd, extraEnv = {}) {
  const home = await tmpdir('llw-home-');
  return {
    cwd,
    env: { HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'), LLW_LOG_PATH: '', ...extraEnv },
  };
}

export const TAP_CMD = (file) => `node --test --test-reporter=tap ${file}`;

// A shell command that runs the same under sh and cmd.exe: double quotes only, no $ or %.
export const nodeCmd = (js) => `node -e "${js}"`;

export const ADD_TEST = `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { add } from '../src/add.js';
// SECRET_TEST_SOURCE_MARKER
test('adds two numbers', () => {
  assert.strictEqual(add(2, 3), 5);
});
`;

export const GOOD_ADD = '```js\nexport function add(a, b) {\n  return a + b;\n}\n```';
export const BAD_ADD = '```js\nexport function add(a, b) {\n  return a - b;\n}\n```';

// Native paths: git prints C:/x on Windows.
export async function worktrees(root) {
  return (await sh(root, 'git', 'worktree', 'list', '--porcelain'))
    .split('\n').filter((l) => l.startsWith('worktree ')).map((l) => path.resolve(l.slice(9)));
}

// A hang fails its suite (and names the unfinished test) instead of the whole run.
export const SUITE = { timeout: 120000 };

// Fake web: a SearXNG /search endpoint plus the pages it points at.
// routes: extra {pathname: (req, res, base) => void} handlers.
export async function fakeWeb({ status = 200, routes = {} } = {}) {
  const long = (word) => `${word} `.repeat(120);
  const state = { searches: [] };
  const pages = {
    '/good': ['text/html', `<html><head><title>Good &amp; Proper</title><script>var SECRET_SCRIPT=1</script></head>
      <body><nav>NAV_MENU</nav><main><h1>Release notes</h1><p>Version 4.2 shipped on 2026&#8209;03&#x2D;01.</p>
      <ul><li>first item</li><li>second item</li></ul><p>${long('detail')}</p></main><footer>FOOTER_TEXT</footer></body></html>`],
    '/plain': ['text/plain', `Plain text page. ${long('plain')}`],
    '/missing': null,
    '/binary': ['application/pdf', '%PDF-1.7'],
    '/empty': ['text/html', '<html><body><div id="app"></div></body></html>'],
  };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (routes[url.pathname]) return routes[url.pathname](req, res, state.url);
    if (url.pathname === '/search') {
      state.searches.push(url.searchParams.get('q'));
      if (status !== 200) { res.writeHead(status); return res.end(); }
      const base = `http://127.0.0.1:${server.address().port}`;
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ results: ['/missing', '/binary', '/empty', '/good', '/good', '/plain'].map((p) => ({ url: base + p, title: p.slice(1) })) }));
    }
    const page = pages[url.pathname];
    if (!page) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': page[0] });
    return res.end(page[1]);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  state.port = server.address().port;
  state.url = `http://127.0.0.1:${state.port}`;
  // Also on [::1] with the same port, so "localhost" works whichever address it
  // resolves to first. Two specific binds, not a '::' wildcard: on Windows another
  // process may bind 127.0.0.1 on a port that is only wildcard-bound here.
  const v6 = http.createServer(server.listeners('request')[0]);
  await new Promise((r) => { v6.once('error', r); v6.listen(state.port, '::1', r); });
  state.close = () => Promise.all([server, v6].map((srv) => new Promise((r) => {
    if (!srv.listening) return r();
    srv.close(r);
    srv.closeAllConnections?.();
    return undefined;
  })));
  return state;
}

