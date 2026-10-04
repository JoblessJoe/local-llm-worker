// Config, backend client, offload, research, delegate and the failure extractor.
// Node >= 18 standard library only.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import dns from 'node:dns';
import fs from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export const DEFAULTS = Object.freeze({
  base_url: 'http://localhost:11434',
  api: 'auto',
  api_key: '',
  headers: {},
  model: '',
  offload_model: '',
  delegate_model: '',
  research_model: '',
  search_url: '',
  research_sources: 3,
  page_timeout_ms: 30000,
  allow_private_urls: false,
  num_ctx: 32768,
  max_tokens: 8192,
  keep_alive: '',
  concurrency: 4,
  timeout_ms: 600000,
  test_timeout_ms: 600000,
  max_attempts: 3,
  link_dirs: ['node_modules', '.venv', 'venv', 'vendor'],
  log_path: '~/.local-llm-worker/runs.jsonl',
  auto_use: ['offload', 'research'],
});

const MAX_ATTEMPTS_CAP = 10;

const KEY_TYPES = {
  base_url: 'string',
  api: 'api',
  api_key: 'string',
  headers: 'headers',
  model: 'string',
  offload_model: 'string',
  delegate_model: 'string',
  research_model: 'string',
  search_url: 'string',
  research_sources: 'int',
  page_timeout_ms: 'int',
  allow_private_urls: 'bool',
  num_ctx: 'int',
  max_tokens: 'int',
  keep_alive: 'duration',
  concurrency: 'int',
  timeout_ms: 'int',
  test_timeout_ms: 'int',
  max_attempts: 'attempts',
  link_dirs: 'string[]',
  log_path: 'string',
  auto_use: 'tools',
};

export const CONFIG_KEYS = Object.keys(DEFAULTS);

// Tools Claude may be told to use on its own (auto_use). configure is always available.
export const AUTO_TOOLS = ['offload', 'research', 'delegate'];

// Returns an error message, or null if the value is valid for the key.
export function validateValue(key, value) {
  const type = KEY_TYPES[key];
  if (!type) return `unknown key "${key}". Valid keys: ${CONFIG_KEYS.join(', ')}`;
  switch (type) {
    case 'string':
      return typeof value === 'string' ? null : `${key} must be a string`;
    case 'api':
      return ['auto', 'ollama', 'openai'].includes(value) ? null : `${key} must be "auto", "ollama" or "openai"`;
    case 'int':
      return Number.isInteger(value) && value > 0 ? null : `${key} must be a positive integer`;
    case 'attempts':
      return Number.isInteger(value) && value >= 1 && value <= MAX_ATTEMPTS_CAP
        ? null
        : `${key} must be an integer from 1 to ${MAX_ATTEMPTS_CAP}`;
    case 'string[]':
      return Array.isArray(value) && value.every((v) => typeof v === 'string')
        ? null
        : `${key} must be an array of strings`;
    case 'bool':
      return typeof value === 'boolean' ? null : `${key} must be true or false`;
    case 'tools':
      return Array.isArray(value) && value.every((v) => AUTO_TOOLS.includes(v))
        ? null
        : `${key} must be an array of tool names from: ${AUTO_TOOLS.join(', ')}`;
    case 'duration':
      // Ollama's keep_alive: seconds as a number (negative = forever), a Go duration
      // string like "30m", or "" to leave the server default.
      return Number.isInteger(value) || value === '' || (typeof value === 'string' && GO_DURATION.test(value))
        ? null
        : `${key} must be an integer number of seconds, a duration like "30m", or ""`;
    case 'headers':
      return value && typeof value === 'object' && !Array.isArray(value)
        && Object.entries(value).every(([k, v]) => HEADER_NAME.test(k) && typeof v === 'string')
        ? null
        : `${key} must be an object of {"Header-Name": "value"} strings`;
  }
  return null;
}

const GO_DURATION = /^-?(\d+(\.\d+)?(ns|us|µs|ms|s|m|h))+$/;
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

// Env values are strings; returns the typed value, undefined to ignore an empty
// value, or the raw string so validation reports it.
function parseEnvValue(key, raw) {
  const type = KEY_TYPES[key];
  const t = raw.trim();
  switch (type) {
    case 'int':
    case 'attempts':
      if (t === '') return undefined;
      return /^\d+$/.test(t) ? Number(t) : raw;
    case 'bool':
      if (t === '') return undefined;
      if (/^(true|1|yes|on)$/i.test(t)) return true;
      if (/^(false|0|no|off)$/i.test(t)) return false;
      return raw;
    case 'duration':
      return /^-?\d+$/.test(t) ? Number(t) : t;
    case 'headers':
      if (t === '') return {};
      try { return JSON.parse(t); } catch { return raw; }
    case 'string[]':
    case 'tools':
      if (t.startsWith('[')) {
        try { return JSON.parse(t); } catch { return raw; }
      }
      return t === '' ? [] : t.split(',').map((s) => s.trim()).filter(Boolean);
  }
  return raw;
}

function homeDir(env) {
  return env.HOME || os.homedir();
}

export function userConfigPath(env = process.env) {
  const base = env.XDG_CONFIG_HOME || path.join(homeDir(env), '.config');
  return path.join(base, 'local-llm-worker', 'config.json');
}

export function projectConfigPath(root) {
  return path.join(root, '.local-llm-worker.json');
}

function expandHome(p, env) {
  if (p === '~') return homeDir(env);
  if (p.startsWith('~/')) return path.join(homeDir(env), p.slice(2));
  return p;
}

async function readJsonFile(file) {
  let text;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  if (text.trim() === '') return {};
  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw new Error(`Invalid JSON in ${file}: ${err.message}`);
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error(`${file} must contain a JSON object`);
  }
  return data;
}

// Git root of cwd, or null if cwd is not inside a work tree. Native separators
// (git prints C:/x on Windows).
export async function gitRoot(cwd) {
  const r = await run('git', ['rev-parse', '--show-toplevel'], { cwd });
  if (r.code !== 0) return null;
  const root = r.stdout.trim();
  return root ? path.resolve(root) : null;
}

// Reads all layers. Called on every tool call, so edits apply without a restart.
export async function loadConfig(ctx = {}) {
  const env = ctx.env || process.env;
  const cwd = ctx.cwd || process.cwd();
  const root = (await gitRoot(cwd)) || cwd;
  const files = { user: userConfigPath(env), project: projectConfigPath(root) };

  const config = { ...DEFAULTS, link_dirs: [...DEFAULTS.link_dirs], auto_use: [...DEFAULTS.auto_use], headers: {} };
  const sources = Object.fromEntries(CONFIG_KEYS.map((k) => [k, 'default']));
  const warnings = [];

  for (const layer of ['user', 'project']) {
    const data = await readJsonFile(files[layer]);
    if (!data) continue;
    for (const [key, value] of Object.entries(data)) {
      const err = validateValue(key, value);
      if (err) {
        warnings.push(`${files[layer]}: ignored ${err}`);
        continue;
      }
      config[key] = value;
      sources[key] = layer;
    }
  }

  for (const key of CONFIG_KEYS) {
    const name = `LLW_${key.toUpperCase()}`;
    if (env[name] === undefined) continue;
    const value = parseEnvValue(key, env[name]);
    if (value === undefined) continue;
    const err = validateValue(key, value);
    if (err) {
      warnings.push(`${name}: ignored ${err}`);
      continue;
    }
    config[key] = value;
    sources[key] = `env ${name}`;
  }

  config.base_url = normalizeBaseUrl(config.base_url);
  config.search_url = config.search_url.replace(/\/+$/, '');
  config.log_path = config.log_path ? expandHome(config.log_path, env) : '';
  return { config, sources, files, warnings, root };
}

export function normalizeBaseUrl(url) {
  let u = String(url).trim().replace(/\/+$/, '');
  if (u.endsWith('/v1')) u = u.slice(0, -3).replace(/\/+$/, '');
  return u;
}

// Merges `set` into the user or project file. A null value removes the key.
export async function writeConfig(set, scope, ctx = {}) {
  if (!set || typeof set !== 'object' || Array.isArray(set)) {
    throw new Error('"set" must be an object of {key: value}');
  }
  if (scope !== 'user' && scope !== 'project') {
    throw new Error('"scope" must be "user" or "project"');
  }
  for (const [key, value] of Object.entries(set)) {
    if (!KEY_TYPES[key]) throw new Error(`Unknown key "${key}". Valid keys: ${CONFIG_KEYS.join(', ')}`);
    if (value === null) continue;
    const err = validateValue(key, value);
    if (err) throw new Error(err);
  }
  const { files } = await loadConfig(ctx);
  const file = files[scope];
  const data = (await readJsonFile(file)) || {};
  for (const [key, value] of Object.entries(set)) {
    if (value === null) delete data[key];
    else data[key] = value;
  }
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2) + '\n');
  await fs.rename(tmp, file);
  return file;
}

// ---------------------------------------------------------------------------
// Processes (always async: execSync would block every other request)
// ---------------------------------------------------------------------------

const MAX_OUTPUT_CHARS = 32 * 1024 * 1024;

export function run(cmd, args, { cwd, timeout, env } = {}) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let child;
    try {
      child = spawn(cmd, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      resolve({ code: -1, stdout, stderr: err.message });
      return;
    }
    const timer = timeout ? setTimeout(() => child.kill('SIGKILL'), timeout) : null;
    child.stdout.setEncoding('utf8').on('data', (d) => { stdout += d; });
    child.stderr.setEncoding('utf8').on('data', (d) => { stderr += d; });
    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: stderr + err.message });
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

// How to run a shell command line on this platform. POSIX: sh in its own
// process group, so a timeout can kill the whole tree. Windows: cmd.exe the way
// Node's `shell: true` calls it; the tree is killed with taskkill instead.
export function shellCommand(command, platform = process.platform) {
  if (platform === 'win32') {
    return {
      file: process.env.ComSpec || 'cmd.exe',
      args: ['/d', '/s', '/c', `"${command}"`],
      options: { windowsVerbatimArguments: true, windowsHide: true, detached: false },
    };
  }
  return { file: '/bin/sh', args: ['-c', command], options: { detached: true } };
}

export function linkType(platform = process.platform) {
  // Junctions need no symlink privilege on Windows; the type is ignored elsewhere.
  return platform === 'win32' ? 'junction' : 'dir';
}

function killTree(child, platform = process.platform) {
  if (platform === 'win32') {
    const k = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    k.on('error', () => child.kill('SIGKILL'));
    return;
  }
  try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
}

// A killed tree whose escaped descendant still holds the pipes would never
// emit 'close'; stop waiting this long after the kill.
const KILL_GRACE_MS = 5000;

// Runs a shell command line, interleaving stdout and stderr. Kills the whole
// process tree on timeout.
export function runShell(command, { cwd, timeout } = {}) {
  return new Promise((resolve) => {
    const env = { ...process.env };
    // Set when we run inside `node --test`; it would switch a nested
    // `node --test` to the binary child protocol instead of TAP.
    delete env.NODE_TEST_CONTEXT;
    let output = '';
    let timedOut = false;
    let done = false;
    let grace = null;
    const finish = (result) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      if (grace) clearTimeout(grace);
      resolve(result);
    };
    const { file, args, options } = shellCommand(command);
    let child;
    try {
      child = spawn(file, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], ...options });
    } catch (err) {
      resolve({ code: -1, output: err.message, timedOut });
      return;
    }
    const onData = (d) => { if (output.length < MAX_OUTPUT_CHARS) output += d; };
    child.stdout.setEncoding('utf8').on('data', onData);
    child.stderr.setEncoding('utf8').on('data', onData);
    const timer = timeout
      ? setTimeout(() => {
        timedOut = true;
        killTree(child);
        grace = setTimeout(() => {
          child.stdout.destroy();
          child.stderr.destroy();
          finish({ code: -1, output, timedOut });
        }, KILL_GRACE_MS);
      }, timeout)
      : null;
    child.on('error', (err) => finish({ code: -1, output: output + err.message, timedOut }));
    child.on('close', (code) => finish({ code: code ?? -1, output, timedOut }));
  });
}

async function git(args, cwd) {
  const r = await run('git', args, { cwd });
  if (r.code !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${(r.stderr || r.stdout).trim()}`);
  }
  return r.stdout;
}

// ---------------------------------------------------------------------------
// Backend client
// ---------------------------------------------------------------------------

function authHeaders(config) {
  const h = { 'content-type': 'application/json', ...(config.headers || {}) };
  if (config.api_key) h.authorization = `Bearer ${config.api_key}`;
  return h;
}

// Secrets never leave in an error message, even if a gateway echoes them back.
function redact(text, config) {
  let out = String(text);
  const secrets = [config.api_key, ...Object.values(config.headers || {})].filter((v) => v && v.length >= 4);
  for (const secret of secrets) out = out.split(secret).join('(redacted)');
  return out;
}

async function redacting(config, fn) {
  try {
    return await fn();
  } catch (err) {
    err.message = redact(err.message, config);
    throw err;
  }
}

async function fetchWithTimeout(url, init, ms) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ac.signal });
  } catch (err) {
    if (ac.signal.aborted) throw new Error(`timed out after ${ms} ms`);
    throw new Error(err.cause?.message || err.message);
  } finally {
    clearTimeout(timer);
  }
}

const PROBE_TIMEOUT_MS = 5000;
const apiCache = new Map();

// Resolves "auto" by probing GET /api/version: answers → ollama, else openai.
export async function detectApi(config) {
  if (config.api && config.api !== 'auto') return config.api;
  const cached = apiCache.get(config.base_url);
  if (cached) return cached;
  let res;
  try {
    res = await fetchWithTimeout(`${config.base_url}/api/version`, { headers: authHeaders(config) }, PROBE_TIMEOUT_MS);
  } catch {
    return 'openai'; // unreachable: don't cache, the real request reports the error
  }
  let api = 'openai';
  if (res.ok) {
    try {
      const body = await res.json();
      if (body && typeof body.version === 'string') api = 'ollama';
    } catch { /* not ollama */ }
  }
  apiCache.set(config.base_url, api);
  return api;
}

export function listModels(config, api) {
  return redacting(config, () => listModelsRaw(config, api));
}

async function listModelsRaw(config, api) {
  const url = api === 'ollama' ? `${config.base_url}/api/tags` : `${config.base_url}/v1/models`;
  let res;
  try {
    res = await fetchWithTimeout(url, { headers: authHeaders(config) }, Math.min(config.timeout_ms, 30000));
  } catch (err) {
    throw new Error(`Cannot reach backend at GET ${url}: ${err.message}`);
  }
  if (!res.ok) {
    throw new Error(`GET ${url} returned HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  const body = await res.json();
  if (api === 'ollama') return (body.models || []).map((m) => m.name || m.model).filter(Boolean);
  return (body.data || []).map((m) => m.id).filter(Boolean);
}

// Explicit override → per-tool model → model → the backend's only model.
export async function resolveModel(config, api, tool, override) {
  const explicit = override || config[`${tool}_model`] || config.model;
  if (explicit) return explicit;
  const models = await listModels(config, api);
  if (models.length === 1) return models[0];
  if (models.length === 0) {
    throw new Error(`No model configured and the backend at ${config.base_url} lists no models. `
      + 'Pull or load a model, then call configure with {set:{model:"<name>"}}.');
  }
  throw new Error(`No model configured and the backend at ${config.base_url} lists ${models.length} models: `
    + `${models.join(', ')}. Call configure with {set:{model:"<name>"}} (or offload_model / delegate_model) to pick one.`);
}

// Per-process limit on in-flight LLM requests. Read from config on each
// acquire so a changed value applies immediately.
let inFlight = 0;
const waiters = [];

async function acquireSlot(limit) {
  while (inFlight >= limit) await new Promise((r) => waiters.push(r));
  inFlight++;
}

function releaseSlot() {
  inFlight--;
  const next = waiters.shift();
  if (next) next();
}

export function stripThink(text) {
  return String(text || '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/^[\s\S]*?<\/think>/i, '') // opening tag consumed by a chat template
    .replace(/^\s*<think>[\s\S]*$/i, '') // opened but never closed: all reasoning, no answer
    .trim();
}

// One non-streaming chat request. Returns {content, in_tok, out_tok, truncated, warning}.
export function chat(opts) {
  return redacting(opts.config, () => chatRaw(opts));
}

async function chatRaw({ config, api, model, messages, temperature }) {
  const ollama = api === 'ollama';
  const url = ollama ? `${config.base_url}/api/chat` : `${config.base_url}/v1/chat/completions`;
  // An explicit output limit on both APIs: some servers default to a short one
  // and would cut code off silently.
  const body = ollama
    ? { model, messages, stream: false, options: { temperature, num_ctx: config.num_ctx, num_predict: config.max_tokens } }
    : { model, messages, temperature, max_tokens: config.max_tokens, stream: false };
  if (ollama && config.keep_alive !== '' && config.keep_alive !== undefined) body.keep_alive = config.keep_alive;

  await acquireSlot(config.concurrency);
  let data;
  try {
    let text;
    try {
      // Timer starts only now, after a slot was acquired. It covers the body too.
      text = await fetchText(url, { method: 'POST', headers: authHeaders(config), body: JSON.stringify(body) }, config.timeout_ms);
    } catch (err) {
      throw new Error(`Backend request failed: POST ${url} (model "${model}"): ${err.message}`);
    }
    if (!text.ok) {
      let hint = '';
      if (text.status === 400 && /max_tokens|context length|maximum context|too long/i.test(text.body)) {
        hint = ` (if the prompt plus max_tokens ${config.max_tokens} exceeds the model's context, lower max_tokens)`;
      }
      throw new Error(`Backend error: POST ${url} (model "${model}") returned HTTP ${text.status}: ${text.body.slice(0, 500)}${hint}`);
    }
    try {
      data = JSON.parse(text.body);
    } catch {
      throw new Error(`Backend error: POST ${url} (model "${model}") returned non-JSON: ${text.body.slice(0, 300)}`);
    }
  } finally {
    releaseSlot();
  }

  let content;
  let inTok;
  let outTok;
  let stop;
  if (ollama) {
    content = data?.message?.content;
    inTok = data?.prompt_eval_count || 0;
    outTok = data?.eval_count || 0;
    stop = data?.done_reason;
  } else {
    content = data?.choices?.[0]?.message?.content;
    inTok = data?.usage?.prompt_tokens || 0;
    outTok = data?.usage?.completion_tokens || 0;
    stop = data?.choices?.[0]?.finish_reason;
  }
  if (typeof content !== 'string') {
    throw new Error(`Backend error: POST ${url} (model "${model}") returned no message content: ${JSON.stringify(data).slice(0, 300)}`);
  }
  const warnings = [];
  // Some backends (Ollama) silently drop part of a prompt that doesn't fit next to
  // max_tokens. Compare what was read with a rough estimate of what was sent.
  const sentTok = messages.reduce((n, m) => n + estimateTokens(m.content), 0);
  if (sentTok > 2000 && inTok > 0 && inTok < 0.7 * sentTok) {
    warnings.push(`Warning: about ${sentTok} tokens were sent but the model read only ${inTok}; `
      + 'the backend truncated the input, so the answer may miss it. Send less material, or raise num_ctx.');
  } else if (ollama && inTok >= 0.95 * config.num_ctx) {
    warnings.push(`Warning: the prompt used ${inTok} of num_ctx ${config.num_ctx} tokens; `
      + 'input was probably truncated. Raise num_ctx or send less material.');
  }
  const truncated = stop === 'length';
  if (truncated) {
    warnings.push(`Warning: the model's output was cut off at max_tokens (${config.max_tokens}). `
      + 'Raise max_tokens with configure, or ask for less.');
  }
  return { content: stripThink(content), in_tok: inTok, out_tok: outTok, truncated, warning: warnings.join('\n') };
}

// POST/GET with one timeout over headers and body. Uses node:http, not fetch:
// fetch (undici) aborts any response whose headers take over 300 s, and a
// non-streamed answer from a slow, thinking or queued model sends its headers
// only when it is done. Here only our own timeout applies. A reset mid-body is
// a request failure. Returns {ok, status, body}.
function fetchText(url, { method = 'GET', headers = {}, body } = {}, ms) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch { return reject(new Error(`invalid URL ${url}`)); }
    const lib = u.protocol === 'https:' ? https : u.protocol === 'http:' ? http : null;
    if (!lib) return reject(new Error(`unsupported protocol ${u.protocol}`));
    const payload = body === undefined ? undefined : Buffer.from(body);
    const req = lib.request(u, {
      method,
      headers: payload ? { ...headers, 'content-length': payload.length } : headers,
    });
    let done = false;
    const finish = (fn, arg) => { if (!done) { done = true; clearTimeout(timer); fn(arg); } };
    const timer = setTimeout(() => {
      req.destroy();
      finish(reject, new Error(`timed out after ${ms} ms`));
    }, ms);
    req.on('error', (err) => finish(reject, new Error(err.message || err.code || 'request failed')));
    req.on('response', (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('error', (err) => finish(reject, new Error(err.message || 'response error')));
      res.on('close', () => {
        if (!res.complete) return finish(reject, new Error('connection closed mid-response'));
        finish(resolve, {
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
          body: Buffer.concat(chunks).toString('utf8'),
        });
      });
    });
    req.end(payload);
  });
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

async function logRun(config, entry) {
  if (!config.log_path) return;
  try {
    await fs.mkdir(path.dirname(config.log_path), { recursive: true });
    await fs.appendFile(config.log_path, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n');
  } catch (err) {
    process.stderr.write(`local-llm-worker: cannot write log ${config.log_path}: ${err.message}\n`);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Resolves rel inside root; throws if it escapes.
export function jail(root, rel) {
  if (typeof rel !== 'string' || rel === '') throw new Error('Path must be a non-empty string');
  const abs = path.resolve(root, rel);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new Error(`Path "${rel}" resolves outside the project root ${root}`);
  }
  return abs;
}

// Like jail, but also follows symlinks: a link inside the root that points out
// of it is refused. Works for paths that do not exist yet.
export async function jailReal(root, rel) {
  const abs = jail(root, rel);
  const realRoot = await realpathOr(root);
  let existing = abs;
  let real;
  for (;;) {
    try {
      real = await fs.realpath(existing);
      break;
    } catch (err) {
      if (err.code !== 'ENOENT' && err.code !== 'ENOTDIR') throw err;
      const up = path.dirname(existing);
      if (up === existing) { real = existing; break; }
      existing = up;
    }
  }
  const resolved = path.join(real, path.relative(existing, abs));
  const inside = (a, b) => (process.platform === 'win32'
    ? a.toLowerCase() === b.toLowerCase() || a.toLowerCase().startsWith(b.toLowerCase() + path.sep)
    : a === b || a.startsWith(b + path.sep));
  if (!inside(resolved, realRoot)) {
    throw new Error(`Path "${rel}" resolves outside the project root ${root} (through a symlink)`);
  }
  return abs;
}

// Decodes bytes as text: the charset if given, else UTF-8, falling back to
// Windows-1252 for bytes that are not valid UTF-8.
const CP1252 = '€\u0081‚ƒ„…†‡ˆ‰Š‹Œ\u008dŽ\u008f\u0090‘’“”•–—˜™š›œ\u009džŸ';
const LATIN = /^(iso-?8859-?1|iso_8859-1|latin-?1|l1|cp1252|windows-1252|x-cp1252|us-ascii|ascii|cp819|ibm819)$/i;

function decodeCp1252(bytes) {
  let out = '';
  for (const b of bytes) out += b >= 0x80 && b <= 0x9f ? CP1252[b - 0x80] : String.fromCharCode(b);
  return out;
}

export function decodeText(bytes, charset) {
  // WHATWG treats all the Latin-1 labels as Windows-1252; Node's TextDecoder
  // does not map 0x80-0x9f, so do it here.
  if (charset && LATIN.test(charset)) return decodeCp1252(bytes);
  if (charset && !/^utf-?8$/i.test(charset)) {
    try { return new TextDecoder(charset).decode(bytes); } catch { /* unknown label: sniff */ }
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return decodeCp1252(bytes);
  }
}

async function exists(p) {
  try {
    await fs.lstat(p);
    return true;
  } catch {
    return false;
  }
}

async function hashFile(p) {
  try {
    return createHash('sha256').update(await fs.readFile(p)).digest('hex');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

const toPosix = (p) => p.split(path.sep).join('/');

function seconds(ms) {
  return (ms / 1000).toFixed(1);
}

// Answers from offload/research are short; reserving the full max_tokens for them
// would waste context that the material needs.
const ANSWER_TOKENS = 2048;

export function answerConfig(config) {
  return { ...config, max_tokens: Math.min(config.max_tokens, ANSWER_TOKENS) };
}

// Rough token count. Common tokenizers (Qwen, Llama 3) split numbers into single
// digits, so a timestamped log runs ~1.8 chars/token while prose runs ~3.5-4. A fixed
// ratio can't serve both: at 3 chars/token, a 74k-char log was really 41k tokens and
// Ollama silently kept only half of the prompt.
export function estimateTokens(text) {
  const digits = (String(text).match(/\d/g) || []).length;
  return Math.ceil(digits + (text.length - digits) / 3.5);
}

// Characters of `text` that fit next to the reply: num_ctx minus max_tokens and room
// for the prompt frame, with a 10 % margin for estimation error.
export function inputCharBudget(config, text) {
  const tokens = Math.max(0, (config.num_ctx - config.max_tokens - 1024) * 0.9);
  const charsPerToken = text.length ? text.length / Math.max(1, estimateTokens(text)) : 3.5;
  return Math.max(1000, Math.floor(tokens * charsPerToken));
}

function cutMiddle(text, budget) {
  if (text.length <= budget) return { text, cut: 0, total: text.length };
  const half = Math.floor(budget / 2);
  const cut = text.length - 2 * half;
  return {
    text: `${text.slice(0, half)}\n\n[... ${cut} characters omitted from the middle ...]\n\n${text.slice(-half)}`,
    cut,
    total: text.length,
  };
}

// Longest fenced block if there are fences, else the raw text.
export function extractCode(text) {
  const blocks = [];
  const re = /```[^\n`]*\n([\s\S]*?)```/g;
  let m;
  while ((m = re.exec(text))) blocks.push(m[1]);
  let code = blocks.length ? blocks.reduce((a, b) => (b.length > a.length ? b : a)) : text.trim();
  if (!code.endsWith('\n')) code += '\n';
  return code;
}

// ---------------------------------------------------------------------------
// Failure extractor
// ---------------------------------------------------------------------------

const FAILURE_CAP = 1500;
const TAP_DROP = /^(---|duration_ms:|type:|location:|failureType:)/;
const TAP_SUMMARY = /^#\s*(tests|suites|pass|fail|cancelled|skipped|todo|duration_ms)\b/;
const GENERIC_MATCH = /FAIL|FAILED|Error|assert|Expected|Received|Traceback|panicked|^E /;

function capText(text, cap) {
  return text.length <= cap ? text : `${text.slice(0, cap)}\n[... truncated]`;
}

function indentOf(line) {
  return line.length - line.trimStart().length;
}

function extractTap(lines) {
  const entries = [];
  let crashed = false;
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)not ok \d+(?: -)?\s*(.*)$/.exec(lines[i]);
    if (!m) continue;
    const body = [];
    let skipIndent = -1;
    let subtestsOnly = false;
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j];
      const t = line.trim();
      if (t === '...' || /^\s*(not )?ok \d+/.test(line) || /^\s*# Subtest:/.test(line)) break;
      if (skipIndent >= 0) {
        if (t === '' || indentOf(line) > skipIndent) continue;
        skipIndent = -1;
      }
      if (/^stack:/.test(t)) { skipIndent = indentOf(line); continue; }
      if (/^failureType:\s*'?subtestsFailed/.test(t)) subtestsOnly = true;
      if (/^exitCode:/.test(t)) crashed = true;
      if (TAP_DROP.test(t)) continue;
      if (t === '') continue;
      body.push(line.slice(Math.min(indentOf(line), m[1].length + 2)));
    }
    // A suite failing only because a child failed adds nothing.
    if (!subtestsOnly) entries.push([`FAILED: ${m[2]}`, ...body].join('\n'));
  }
  if (!entries.length) return '';
  let out = entries.join('\n\n');
  if (crashed) {
    // The file never ran its tests; the reason is in the diagnostics.
    const diag = lines
      .filter((l) => /^\s*#/.test(l) && !/^\s*# Subtest:/.test(l) && !TAP_SUMMARY.test(l.trim()))
      .map((l) => l.replace(/^\s*# ?/, ''));
    if (diag.length) out = `${diag.join('\n')}\n\n${out}`;
  }
  return out;
}

function extractGeneric(lines) {
  const keep = new Set();
  lines.forEach((line, i) => {
    if (!GENERIC_MATCH.test(line)) return;
    for (let k = Math.max(0, i - 2); k <= Math.min(lines.length - 1, i + 2); k++) keep.add(k);
  });
  if (!keep.size) return '';
  const out = [];
  const seen = new Set();
  let prev = -2;
  for (const i of [...keep].sort((a, b) => a - b)) {
    const line = lines[i];
    if (line.trim() !== '' && seen.has(line)) continue;
    seen.add(line);
    if (prev >= 0 && i !== prev + 1) out.push('...');
    out.push(line);
    prev = i;
  }
  return out.join('\n').trim();
}

export function extractFailures(output) {
  const text = String(output || '').replace(/\r\n/g, '\n');
  const lines = text.split('\n');
  const parsed = extractTap(lines) || extractGeneric(lines) || text.trim();
  return capText(parsed || '(test command failed with no output)', FAILURE_CAP);
}

// ---------------------------------------------------------------------------
// Tool: configure
// ---------------------------------------------------------------------------

export async function configure(args = {}, ctx = {}) {
  if (args.set !== undefined) {
    await writeConfig(args.set, args.scope || 'user', ctx);
  }
  const { config, sources, files, warnings } = await loadConfig(ctx);
  const api = await detectApi(config);
  let reachable = false;
  let models = [];
  let modelsError;
  try {
    models = await listModels(config, api);
    reachable = true;
  } catch (err) {
    modelsError = err.message;
  }
  const resolved = {};
  for (const tool of ['offload', 'delegate', 'research']) {
    const explicit = config[`${tool}_model`] || config.model;
    if (explicit) resolved[tool] = explicit;
    else if (models.length === 1) resolved[tool] = models[0];
    else resolved[tool] = null;
  }
  const effective = { ...config };
  if (effective.api_key) effective.api_key = '(set)';
  effective.headers = Object.fromEntries(Object.keys(config.headers).map((k) => [k, '(set)']));
  const report = {
    effective,
    sources,
    files,
    api: config.api !== 'auto' ? api : reachable ? `${api} (auto-detected)` : 'unknown (backend unreachable)',
    reachable,
    models,
    models_error: modelsError,
    resolved_models: resolved,
    warnings: warnings.length ? warnings : undefined,
    how_to_change: 'configure {"set": {"key": value}, "scope": "user"|"project"}; a null value removes the key. '
      + 'Applies on the next call, no restart. Env vars LLW_<KEY> override both files.',
  };
  return JSON.stringify(report, null, 2);
}

// ---------------------------------------------------------------------------
// Tool: offload
// ---------------------------------------------------------------------------

const OFFLOAD_SYSTEM = 'You answer questions about the material provided by the user. '
  + 'Answer ONLY from that material. Quote exact lines, numbers and paths when they matter. '
  + 'Be concise. If the material does not answer the question, say so plainly.';

export async function offload(args = {}, ctx = {}) {
  const started = Date.now();
  if (typeof args.task !== 'string' || !args.task.trim()) throw new Error('"task" is required');
  const files = args.files ?? [];
  if (!Array.isArray(files)) throw new Error('"files" must be an array of paths');
  if (!files.length && !args.command) throw new Error('Give "files" and/or "command" as the material to read');

  const config = answerConfig((await loadConfig(ctx)).config);
  const cwd = ctx.cwd || process.cwd();
  const root = (await gitRoot(cwd)) || cwd;

  const parts = [];
  for (const rel of files) {
    const abs = await jailReal(root, rel);
    let bytes;
    try {
      bytes = await fs.readFile(abs);
    } catch (err) {
      throw new Error(`Cannot read "${rel}": ${err.message}`);
    }
    if (bytes.subarray(0, 8192).includes(0)) {
      throw new Error(`"${rel}" looks like a binary file; offload reads text (pass a command that renders it, e.g. a hex dump)`);
    }
    const content = bytes.length ? decodeText(bytes) : '(empty file)';
    parts.push(`### File: ${toPosix(path.relative(root, abs))}\n${content}`);
  }
  if (args.command) {
    ctx.progress?.('running command');
    const r = await runShell(args.command, { cwd: root, timeout: config.test_timeout_ms });
    const status = r.timedOut ? `timed out after ${config.test_timeout_ms} ms` : `exit code ${r.code}`;
    parts.push(`### Output of \`${args.command}\` (${status})\n${r.output}`);
  }

  const joined = parts.join('\n\n');
  const budget = inputCharBudget(config, joined);
  const { text: material, cut, total } = cutMiddle(joined, budget);
  const cutNote = cut
    ? `Note: the material was ${total} characters, over the ${budget}-character budget; `
      + `${cut} characters were omitted from the middle (head and tail kept).`
    : '';

  const api = await detectApi(config);
  const model = await resolveModel(config, api, 'offload', args.model);
  ctx.progress?.(`${model} is reading the material`);
  let res;
  let ok = false;
  try {
    res = await chat({
      config,
      api,
      model,
      temperature: 0.1,
      messages: [
        { role: 'system', content: OFFLOAD_SYSTEM },
        // The question goes before AND after the material, so a cut at either end can't lose it.
        { role: 'user', content: `## Question\n${args.task}\n\n${cutNote ? `${cutNote}\n\n` : ''}## Material\n${material}\n\n## Question (repeated)\n${args.task}` },
      ],
    });
    ok = true;
  } finally {
    await logRun(config, {
      tool: 'offload', model, api, ok, attempts: 1,
      in_tok: res?.in_tok || 0, out_tok: res?.out_tok || 0, ms: Date.now() - started,
    });
  }

  const lines = [res.content || '(empty answer)', ''];
  if (cutNote) lines.push(cutNote);
  if (res.warning) lines.push(res.warning);
  lines.push(`— ${model} · ${seconds(Date.now() - started)}s · ${res.in_tok} input tokens read locally`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Tool: research
// ---------------------------------------------------------------------------

const RESEARCH_SYSTEM = 'You are a research assistant. Answer ONLY from the supplied sources. '
  + 'Quote exact figures, version numbers and dates rather than paraphrasing them. '
  + 'Cite the source number inline like [1] for every claim. '
  + 'If the sources do not answer the question, say so plainly and state what they DO establish. '
  + 'Never use knowledge that is not in the sources.';

const MAX_RESEARCH_SOURCES = 10;
const MAX_PAGE_BYTES = 5 * 1024 * 1024;
const MIN_PAGE_CHARS = 200;
const SEARXNG_HINT = 'Point search_url at a SearXNG instance with JSON output enabled '
  + '(docker image searxng/searxng; add "json" under search.formats in its settings.yml), '
  + 'e.g. configure {"set":{"search_url":"http://localhost:8888"}}. '
  + 'Or pass "urls" to read specific pages without searching.';

async function searxSearch(config, query) {
  const url = `${config.search_url}/search?${new URLSearchParams({ q: query, format: 'json' })}`;
  let res;
  try {
    res = await fetchWithTimeout(url, { headers: { accept: 'application/json' } }, config.page_timeout_ms);
  } catch (err) {
    throw new Error(`Cannot reach SearXNG at ${config.search_url}: ${err.message}. ${SEARXNG_HINT}`);
  }
  if (res.status === 403) {
    throw new Error(`SearXNG at ${config.search_url} returned HTTP 403: its JSON output is disabled. `
      + 'Add "json" under search.formats in its settings.yml.');
  }
  if (!res.ok) throw new Error(`SearXNG at ${config.search_url} returned HTTP ${res.status}`);
  let body;
  try {
    body = JSON.parse(await res.text());
  } catch (err) {
    throw new Error(`SearXNG at ${config.search_url} returned invalid JSON (${err.message}). ${SEARXNG_HINT}`);
  }
  if (!body || !Array.isArray(body.results)) {
    throw new Error(`SearXNG at ${config.search_url} returned JSON without a "results" list`);
  }
  const seen = new Set();
  return (body.results || [])
    .filter((r) => typeof r.url === 'string' && /^https?:\/\//i.test(r.url) && !seen.has(r.url) && seen.add(r.url))
    .map((r) => ({ url: r.url, title: r.title || r.url }));
}

// Page URLs come from search results or the caller, so by default they may not
// reach loopback, link-local or private networks (the search endpoint itself is
// configured by the user and exempt).
const BLOCKED_V4 = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 3],
];
const BLOCKED_V6 = [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]];
const blockList = new net.BlockList();
for (const [a, n] of BLOCKED_V4) blockList.addSubnet(a, n, 'ipv4');
for (const [a, n] of BLOCKED_V6) blockList.addSubnet(a, n, 'ipv6');

export function isPrivateAddress(address) {
  let a = String(address).replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  const mapped = /^::ffff:(.+)$/i.exec(a);
  if (mapped) {
    // IPv4-mapped IPv6, dotted (::ffff:127.0.0.1) or hex (::ffff:7f00:1).
    const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(mapped[1]);
    a = hex
      ? [parseInt(hex[1], 16) >> 8, parseInt(hex[1], 16) & 255, parseInt(hex[2], 16) >> 8, parseInt(hex[2], 16) & 255].join('.')
      : mapped[1];
  }
  const family = net.isIP(a);
  if (family === 4) return blockList.check(a, 'ipv4');
  if (family === 6) return blockList.check(a, 'ipv6');
  return true; // not an address at all: refuse
}

function lookupAll(host, lookup) {
  return new Promise((resolve, reject) => {
    lookup(host, { all: true, verbatim: true }, (err, addrs) => (err ? reject(err) : resolve(addrs)));
  });
}

// Returns a refusal reason, or null if the URL may be fetched.
async function refusePageUrl(url, policy) {
  if (!/^https?:$/.test(url.protocol)) return `unsupported protocol ${url.protocol}`;
  if (policy.allowPrivate) return null;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  let addrs;
  if (net.isIP(host)) {
    addrs = [{ address: host }];
  } else {
    try {
      addrs = await lookupAll(host, policy.lookup || dns.lookup);
    } catch (err) {
      return `cannot resolve ${host}: ${err.code || err.message}`;
    }
  }
  const bad = addrs.find((a) => isPrivateAddress(a.address));
  return bad
    ? `refused: ${host} resolves to private address ${bad.address} (set allow_private_urls to allow)`
    : null;
}

const MAX_REDIRECTS = 5;

async function fetchPage(url, ms, policy = {}) {
  try {
    // One signal covers every hop, headers and body: a stalled body must not hang the call.
    const signal = AbortSignal.timeout(ms);
    let current = new URL(url);
    let res;
    for (let hop = 0; ; hop++) {
      const refused = await refusePageUrl(current, policy);
      if (refused) return { ok: false, reason: hop ? `redirect to ${current.href} ${refused}` : refused };
      // Redirects are followed by hand so every hop passes the check above.
      res = await fetch(current, {
        signal,
        redirect: 'manual',
        headers: {
          'user-agent': 'Mozilla/5.0 (compatible; local-llm-worker)',
          accept: 'text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.5',
        },
      });
      if (![301, 302, 303, 307, 308].includes(res.status)) break;
      const location = res.headers.get('location');
      await res.body?.cancel().catch(() => {});
      if (!location) return { ok: false, reason: `HTTP ${res.status} without a Location header` };
      if (hop >= MAX_REDIRECTS) return { ok: false, reason: `more than ${MAX_REDIRECTS} redirects` };
      current = new URL(location, current);
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      return { ok: false, reason: `HTTP ${res.status}` };
    }
    const type = (res.headers.get('content-type') || '').toLowerCase();
    const html = type.includes('html');
    if (!html && type && !/^text\/|json|xml|markdown/.test(type)) {
      await res.body?.cancel().catch(() => {});
      return { ok: false, reason: `unsupported content-type ${type.split(';')[0]}` };
    }
    const bytes = await readCapped(res, MAX_PAGE_BYTES);
    const raw = decodeBody(bytes, type, html);
    const text = html ? htmlToText(raw) : raw.trim();
    if (text.length < MIN_PAGE_CHARS) return { ok: false, reason: 'no readable text (JavaScript-rendered page?)' };
    return { ok: true, text, title: html ? htmlTitle(raw) : '' };
  } catch (err) {
    const reason = err.name === 'TimeoutError' ? `timed out after ${ms} ms` : (err.cause?.message || err.message);
    return { ok: false, reason };
  }
}

// Reads at most cap bytes and drops the rest unread.
async function readCapped(res, cap) {
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  while (size < cap) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.length;
  }
  if (size >= cap) await reader.cancel().catch(() => {});
  return Buffer.concat(chunks).subarray(0, cap);
}

// Charset from the Content-Type header, else from an HTML <meta>, else UTF-8.
function decodeBody(bytes, type, html) {
  let charset = /charset=["']?([\w.:-]+)/i.exec(type)?.[1];
  if (!charset && html) {
    charset = /<meta[^>]+charset=["']?([\w.:-]+)/i.exec(bytes.subarray(0, 4096).toString('latin1'))?.[1];
  }
  return decodeText(bytes, charset);
}

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…',
  rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', laquo: '«', raquo: '»', middot: '·', bull: '•',
  copy: '©', reg: '®', trade: '™', times: '×', deg: '°', euro: '€',
};

function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] !== '#') return ENTITIES[e.toLowerCase()] ?? m;
    const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    try { return String.fromCodePoint(n); } catch { return m; }
  });
}

function htmlTitle(html) {
  const m = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(html);
  return m ? decodeEntities(m[1]).replace(/\s+/g, ' ').trim() : '';
}

// ponytail: regex HTML-to-text, no DOM (zero dependencies). Fine for articles and docs;
// complex tables and JS-rendered pages come out rough. Swap in a real parser if answers suffer.
export function htmlToText(html) {
  let s = String(html).replace(/<!--[\s\S]*?-->/g, '');
  s = s.replace(/<(script|style|noscript|svg|template|iframe|head|nav|footer|aside|form|button)\b[\s\S]*?<\/\1\s*>/gi, ' ');
  // Prefer the page's own main content when it marks it.
  const lower = s.toLowerCase();
  for (const tag of ['main', 'article']) {
    const open = lower.search(new RegExp(`<${tag}\\b`));
    const close = lower.lastIndexOf(`</${tag}`);
    if (open < 0 || close <= open) continue;
    const inner = s.slice(open, close);
    if (inner.replace(/<[^>]+>/g, '').trim().length > 500) { s = inner; break; }
  }
  s = s.replace(/<h([1-6])\b[^>]*>/gi, (m, n) => `\n\n${'#'.repeat(Number(n))} `);
  s = s.replace(/<li\b[^>]*>/gi, '\n- ');
  s = s.replace(/<(br|hr)\b[^>]*>/gi, '\n');
  s = s.replace(/<\/t[dh]\s*>/gi, ' | ');
  s = s.replace(/<\/?(p|div|section|article|main|header|ul|ol|table|thead|tbody|tr|blockquote|pre|h[1-6]|dl|dt|dd|figure|figcaption)\b[^>]*>/gi, '\n');
  s = decodeEntities(s.replace(/<[^>]+>/g, ''));
  return s.split('\n')
    .map((l) => l.replace(/[ \t ]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export async function research(args = {}, ctx = {}) {
  const started = Date.now();
  const { question } = args;
  if (typeof question !== 'string' || !question.trim()) throw new Error('"question" is required');
  const urls = args.urls ?? [];
  if (!Array.isArray(urls) || urls.some((u) => typeof u !== 'string' || !/^https?:\/\//i.test(u))) {
    throw new Error('"urls" must be an array of http(s) URLs');
  }

  const config = answerConfig((await loadConfig(ctx)).config);
  let candidates;
  let limit;
  if (urls.length) {
    candidates = [...new Set(urls)].map((url) => ({ url, title: url }));
    limit = Math.min(candidates.length, MAX_RESEARCH_SOURCES);
  } else {
    if (!config.search_url) throw new Error(`No search_url configured. ${SEARXNG_HINT}`);
    const query = typeof args.query === 'string' && args.query.trim() ? args.query : question;
    ctx.progress?.(`searching for "${query}"`);
    candidates = await searxSearch(config, query);
    if (!candidates.length) throw new Error(`SearXNG returned no results for "${query}"`);
    const want = Number.isInteger(args.max_sources) ? args.max_sources : config.research_sources;
    limit = Math.min(Math.max(want, 1), MAX_RESEARCH_SOURCES);
  }

  // Fetch in parallel batches; walk further down the results when pages fail.
  const sources = [];
  const failed = [];
  const policy = { allowPrivate: config.allow_private_urls, lookup: ctx.lookup };
  for (let i = 0; i < candidates.length && sources.length < limit; i += limit) {
    const batch = candidates.slice(i, i + limit);
    ctx.progress?.(`reading ${batch.length} page${batch.length === 1 ? '' : 's'}`);
    const pages = await Promise.all(batch.map((c) => fetchPage(c.url, config.page_timeout_ms, policy)));
    batch.forEach((c, k) => {
      const p = pages[k];
      if (!p.ok) failed.push(`${c.url}: ${p.reason}`);
      else if (sources.length < limit) sources.push({ url: c.url, title: p.title || c.title, text: p.text });
    });
  }
  if (!sources.length) {
    throw new Error(`Could not read any page:\n${failed.slice(0, 5).map((f) => `- ${f}`).join('\n')}`);
  }

  // Share the context budget evenly; keep each page's head, where the substance usually is.
  const share = Math.floor(inputCharBudget(config, sources.map((s) => s.text).join('')) / sources.length);
  for (const s of sources) {
    s.chars = s.text.length;
    if (s.text.length > share) s.text = `${s.text.slice(0, share)}\n[... truncated]`;
  }
  const corpus = sources
    .map((s, n) => `### SOURCE [${n + 1}] ${s.title}\nURL: ${s.url}\n\n${s.text}`)
    .join('\n\n---\n\n');

  const api = await detectApi(config);
  const model = await resolveModel(config, api, 'research', args.model);
  ctx.progress?.(`${model} is answering from ${sources.length} page${sources.length === 1 ? '' : 's'}`);
  let res;
  let ok = false;
  try {
    res = await chat({
      config,
      api,
      model,
      temperature: 0.1,
      messages: [
        { role: 'system', content: RESEARCH_SYSTEM },
        { role: 'user', content: `# Question\n${question}\n\n# Sources (full page text)\n\n${corpus}\n\n# Question (repeated)\n${question}` },
      ],
    });
    ok = true;
  } finally {
    await logRun(config, {
      tool: 'research', model, api, ok, attempts: 1,
      in_tok: res?.in_tok || 0, out_tok: res?.out_tok || 0, ms: Date.now() - started,
    });
  }

  const lines = [res.content || '(empty answer)', '', 'Sources (read in full locally):'];
  sources.forEach((s, n) => {
    lines.push(`[${n + 1}] ${s.title} — ${s.url} (${s.chars} chars${s.chars > share ? ', truncated' : ''})`);
  });
  if (failed.length) {
    lines.push(`Unreadable, skipped: ${failed.length}`);
    for (const f of failed.slice(0, 3)) lines.push(`- ${f}`);
  }
  if (res.warning) lines.push(res.warning);
  lines.push(`— ${model} · ${seconds(Date.now() - started)}s · ${res.in_tok} input tokens read locally`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Tool: delegate
// ---------------------------------------------------------------------------

const DELEGATE_SYSTEM = 'You are a senior engineer. Implement exactly what the specification asks. '
  + 'Use ONLY the APIs given to you — never invent a function, table or column name. '
  + 'If the spec is missing something you need, write a TODO comment naming what is missing rather than guessing. '
  + 'Output a complete runnable file as code and nothing else.';

// Worktree add/remove touch shared git metadata; serialize just those steps
// per repository. LLM requests and test runs stay parallel.
const repoLocks = new Map();

function withRepoLock(root, fn) {
  const prev = repoLocks.get(root) || Promise.resolve();
  const next = prev.then(fn, fn);
  const tail = next.catch(() => {});
  repoLocks.set(root, tail);
  tail.then(() => { if (repoLocks.get(root) === tail) repoLocks.delete(root); });
  return next;
}

function splitZ(out) {
  return out.split('\0').filter(Boolean);
}

// Worktree dirs this process is using right now.
const activeWorktrees = new Set();
const WORKTREE_PREFIX = 'llw-';
const STALE_WORKTREE_MS = 24 * 3600 * 1000;
const MIRROR_MAX_BYTES = 10 * 1024 * 1024;

async function realpathOr(p) {
  try { return await fs.realpath(p); } catch { return path.resolve(p); }
}

function samePath(a, b) {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

// A server that died mid-delegate leaves llw-* worktrees behind. Drop the ones
// whose directory is gone, and the ones older than a day that this process is
// not using. Called under the repo lock.
async function cleanupWorktrees(root) {
  await run('git', ['worktree', 'prune'], { cwd: root });
  const r = await run('git', ['worktree', 'list', '--porcelain'], { cwd: root });
  if (r.code !== 0) return;
  const tmp = await realpathOr(os.tmpdir());
  const dirs = r.stdout.split('\n').filter((l) => l.startsWith('worktree ')).map((l) => path.resolve(l.slice(9)));
  for (const dir of dirs.slice(1)) { // the first entry is the main worktree
    if (!path.basename(dir).startsWith(WORKTREE_PREFIX)) continue;
    if (!samePath(await realpathOr(path.dirname(dir)), tmp)) continue;
    if ([...activeWorktrees].some((a) => samePath(a, dir))) continue;
    let st = null;
    try { st = await fs.stat(dir); } catch { /* gone */ }
    if (st && Date.now() - st.mtimeMs < STALE_WORKTREE_MS) continue;
    const rm = await run('git', ['worktree', 'remove', '--force', dir], { cwd: root });
    if (rm.code !== 0) {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
      await run('git', ['worktree', 'prune'], { cwd: root });
    }
  }
}

async function createWorktree(root, linkDirs) {
  // Real path: on macOS the tmpdir is a symlink, and git reports real paths.
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), WORKTREE_PREFIX)));
  activeWorktrees.add(dir);
  try {
    await withRepoLock(root, async () => {
      await cleanupWorktrees(root);
      await git(['worktree', 'add', '--detach', dir, 'HEAD'], root);
    });
  } catch (err) {
    activeWorktrees.delete(dir);
    await fs.rm(dir, { recursive: true, force: true });
    throw err;
  }
  const wt = { dir, links: [], skippedLarge: 0 };
  try {
    await populateWorktree(root, wt, linkDirs);
  } catch (err) {
    await removeWorktree(root, wt).catch(() => {});
    throw err;
  }
  return wt;
}

async function populateWorktree(root, wt, linkDirs) {
  const { dir, links } = wt;
  for (const name of linkDirs) {
    let src;
    try { src = jail(root, name); } catch { continue; }
    const dst = path.join(dir, path.relative(root, src));
    if (!(await exists(src)) || (await exists(dst))) continue;
    await fs.mkdir(path.dirname(dst), { recursive: true });
    await fs.symlink(src, dst, linkType());
    links.push(toPosix(path.relative(root, src)));
  }
  const underLink = (rel) => links.some((l) => rel === l || rel.startsWith(l + '/'));

  // Mirror the uncommitted state: Claude's new test is usually not committed.
  // git lists a symlinked directory as one entry and never descends into it.
  const modified = splitZ(await git(['ls-files', '-z', '-m'], root));
  const untracked = new Set(splitZ(await git(['ls-files', '-z', '-o', '--exclude-standard'], root)));
  for (const rel of new Set([...modified, ...untracked])) {
    if (underLink(rel)) continue;
    const src = path.join(root, rel);
    const dst = path.join(dir, rel);
    let st;
    try { st = await fs.lstat(src); } catch { continue; } // deleted; handled below
    if (!st.isFile() && !st.isSymbolicLink()) continue; // e.g. a submodule
    if (st.isFile() && untracked.has(rel) && st.size > MIRROR_MAX_BYTES) {
      wt.skippedLarge++;
      continue;
    }
    await fs.mkdir(path.dirname(dst), { recursive: true });
    await fs.rm(dst, { force: true });
    try {
      if (st.isSymbolicLink()) await fs.symlink(await fs.readlink(src), dst);
      else await fs.copyFile(src, dst);
    } catch (err) {
      // Deleted mid-run, or no symlink privilege (Windows): skip that one file.
      if (!['ENOENT', 'EPERM', 'EACCES'].includes(err.code)) throw err;
    }
  }
  for (const rel of splitZ(await git(['ls-files', '-z', '-d'], root))) {
    await fs.rm(path.join(dir, rel), { force: true });
  }
}

async function removeWorktree(root, wt) {
  for (const l of wt.links) await fs.rm(path.join(wt.dir, l), { force: true });
  await withRepoLock(root, async () => {
    const r = await run('git', ['worktree', 'remove', '--force', wt.dir], { cwd: root });
    if (r.code !== 0) {
      await fs.rm(wt.dir, { recursive: true, force: true });
      await run('git', ['worktree', 'prune'], { cwd: root });
    }
  });
  activeWorktrees.delete(wt.dir);
}

function asList(value) {
  if (value === undefined || value === null || value === '') return '';
  if (Array.isArray(value)) return value.map((v, i) => `${i + 1}. ${v}`).join('\n');
  return String(value);
}

export function buildDelegatePrompt({ target, spec, context, properties, current, failure }) {
  const parts = [`## Target file: ${target}`];
  parts.push(`## Exact APIs available (use these verbatim)\n${context || '(none given: use only the language standard library and what the task names)'}`);
  parts.push(`## Task\n${spec}`);
  const props = asList(properties);
  if (props) parts.push(`## Invariants — these must hold for EVERY possible input\n${props}`);
  if (current !== null && current !== undefined) {
    parts.push(`## Current content of ${target} — modify this; return the COMPLETE new file\n\`\`\`\n${current}\`\`\``);
  }
  if (failure) parts.push(`## Your previous attempt FAILED. Fix it.\n${failure}`);
  return parts.join('\n\n');
}

export async function delegate(args = {}, ctx = {}) {
  const started = Date.now();
  for (const key of ['spec', 'target_file', 'test_command']) {
    if (typeof args[key] !== 'string' || !args[key].trim()) throw new Error(`"${key}" is required`);
  }
  const testFiles = args.test_files ?? [];
  if (!Array.isArray(testFiles)) throw new Error('"test_files" must be an array of paths');

  const cwd = ctx.cwd || process.cwd();
  const root = await gitRoot(cwd);
  if (!root) throw new Error(`delegate needs a git repository; ${cwd} is not inside one`);
  if ((await run('git', ['rev-parse', '--verify', '--quiet', 'HEAD'], { cwd: root })).code !== 0) {
    throw new Error(`The repository at ${root} has no commits yet; commit once so a worktree can be created`);
  }

  const targetAbs = await jailReal(root, args.target_file);
  if (targetAbs === root) throw new Error('target_file must be a file, not the project root');
  try {
    if ((await fs.stat(targetAbs)).isDirectory()) throw new Error(`target_file "${args.target_file}" is a directory; name a file`);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  for (const t of testFiles) {
    if (jail(root, t) === targetAbs) {
      throw new Error(`target_file "${args.target_file}" is one of the test_files; the worker may not write the test`);
    }
  }
  // Forward slashes on every platform: this path is shown to the model and the caller.
  const targetRel = toPosix(path.relative(root, targetAbs));

  const { config } = await loadConfig({ ...ctx, cwd: root });
  const maxAttempts = Math.min(MAX_ATTEMPTS_CAP, Math.max(1, Number.isInteger(args.max_attempts) ? args.max_attempts : config.max_attempts));
  const api = await detectApi(config);
  const model = await resolveModel(config, api, 'delegate', args.model);
  const showCode = args.show_code === true;
  const apply = args.apply !== false;

  let wt = null;
  let keep = false;
  let inTok = 0;
  let outTok = 0;
  let attempt = 0;
  let passed = false;
  let code = '';
  let failure = '';
  const warnings = new Set();
  // The target as the caller saw it: any change after this is a conflict,
  // including one applied by a parallel delegate.
  const realHash = await hashFile(targetAbs);
  try {
    ctx.progress?.('creating worktree');
    wt = await createWorktree(root, config.link_dirs);
    const wtTarget = path.join(wt.dir, targetRel);
    let current = null;
    try { current = await fs.readFile(wtTarget, 'utf8'); } catch { /* new file */ }

    for (attempt = 1; attempt <= maxAttempts; attempt++) {
      ctx.progress?.(`attempt ${attempt}/${maxAttempts}: ${model} is writing ${targetRel}`);
      const res = await chat({
        config,
        api,
        model,
        temperature: 0.2,
        messages: [
          { role: 'system', content: DELEGATE_SYSTEM },
          {
            role: 'user',
            content: buildDelegatePrompt({
              target: targetRel, spec: args.spec, context: args.context,
              properties: args.properties, current, failure,
            }),
          },
        ],
      });
      inTok += res.in_tok;
      outTok += res.out_tok;
      if (res.warning) warnings.add(res.warning);
      code = extractCode(res.content);
      if (res.truncated) {
        // Cut-off code would only fail the tests with a confusing syntax error.
        failure = `Your output was cut off at max_tokens (${config.max_tokens}) before the file was complete. `
          + 'Return the complete file, shorter: no explanations, only the code.';
        continue;
      }
      await fs.mkdir(path.dirname(wtTarget), { recursive: true });
      await fs.writeFile(wtTarget, code);

      // Test output is parsed; the test source itself never reaches the worker.
      ctx.progress?.(`attempt ${attempt}/${maxAttempts}: running tests`);
      const r = await runShell(args.test_command, { cwd: wt.dir, timeout: config.test_timeout_ms });
      if (r.code === 0 && !r.timedOut) {
        passed = true;
        break;
      }
      failure = r.timedOut
        ? capText(`Test command timed out after ${config.test_timeout_ms} ms (infinite loop or hang?).\n${extractFailures(r.output)}`, FAILURE_CAP)
        : extractFailures(r.output);
    }
    if (attempt > maxAttempts) attempt = maxAttempts;

    let applied = false;
    let note = '';
    if (passed && apply) {
      // Check and write as one step per target, so parallel delegates to the
      // same file cannot both see it unchanged.
      applied = await withRepoLock(`apply:${targetAbs}`, async () => {
        if ((await hashFile(targetAbs)) !== realHash) return false;
        await fs.mkdir(path.dirname(targetAbs), { recursive: true });
        await fs.writeFile(targetAbs, code);
        return true;
      });
      if (!applied) note = `Not applied: ${targetRel} changed in the checkout during the run. The passing file is at ${wtTarget}`;
    } else if (passed) {
      note = `Not applied (apply:false). The passing file is at ${wtTarget}`;
    }
    keep = !passed || !applied;
    if (keep) activeWorktrees.delete(wt.dir); // kept for the user, no longer in use

    const lineCount = code ? code.replace(/\n$/, '').split('\n').length : 0;
    const out = [
      `${passed ? 'PASS' : 'FAIL'} · attempt ${attempt}/${maxAttempts} · ${targetRel} (${lineCount} lines) · applied: ${applied ? 'yes' : 'no'}`,
      `${model} · ${seconds(Date.now() - started)}s · ${outTok} tokens generated locally`,
    ];
    if (note) out.push(note);
    if (wt.skippedLarge) {
      const n = wt.skippedLarge;
      out.push(`Note: ${n} untracked file${n === 1 ? '' : 's'} over ${MIRROR_MAX_BYTES / 1024 / 1024} MB `
        + `${n === 1 ? 'was' : 'were'} not copied into the worktree.`);
    }
    if (!passed) out.push(`Last failure:\n${capText(failure, 800)}`);
    if (keep) out.push(`Worktree kept: ${wt.dir}\nRemove with: git worktree remove --force ${wt.dir}`);
    for (const w of warnings) out.push(w);
    if (showCode) out.push(`\`\`\`\n${code}\`\`\``);
    return out.join('\n');
  } finally {
    if (wt && !keep) {
      try {
        await removeWorktree(root, wt);
      } catch (err) {
        process.stderr.write(`local-llm-worker: cannot remove worktree ${wt.dir}: ${err.message}\n`);
      }
    }
    await logRun(config, {
      tool: 'delegate', model, api, ok: passed, attempts: attempt,
      in_tok: inTok, out_tok: outTok, ms: Date.now() - started,
    });
  }
}
