#!/usr/bin/env node
// MCP server over stdio: newline-delimited JSON-RPC 2.0.
// Only protocol JSON goes to stdout; everything else goes to stderr.

import { readFileSync } from 'node:fs';
import readline from 'node:readline';
import { configure, offload, research, delegate, CONFIG_KEYS } from './worker.js';

console.log = console.error;

const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

const TOOLS = [
  {
    name: 'offload',
    description: 'Read big output with the LOCAL model instead of reading it yourself: test runs, builds, logs, large files or diffs. '
      + 'It reads files and/or a command\'s output and answers your question. '
      + 'Only the short answer comes back, so large logs, files or diffs never enter your context. '
      + 'Good for: summarising a huge test log, finding where something is defined across big files, extracting numbers.',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'The question to answer from the material.' },
        files: { type: 'array', items: { type: 'string' }, description: 'Paths relative to the git root (or cwd outside a repo).' },
        command: { type: 'string', description: 'Shell command whose stdout+stderr is the material (e.g. a test run).' },
        model: { type: 'string', description: 'Override the configured model for this call.' },
      },
      required: ['task'],
    },
  },
  {
    name: 'research',
    description: 'Web lookup with the LOCAL model, instead of WebSearch/WebFetch: docs, current versions, facts from pages. '
      + 'Answers a question from the live web WITHOUT the pages entering your context. '
      + 'Searches SearXNG (or reads the "urls" you give), downloads the pages in full, has the LOCAL model answer '
      + 'with inline [n] citations, and returns only that answer plus the source list. '
      + 'Use it when the details on the pages matter. Slow by design: expect tens of seconds to minutes.',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'The research question, in full.' },
        query: { type: 'string', description: 'Search query if it should differ from the question.' },
        urls: { type: 'array', items: { type: 'string' }, description: 'Read these pages instead of searching (no search_url needed).' },
        max_sources: { type: 'integer', minimum: 1, maximum: 10, description: 'Pages to read when searching (default from config).' },
        model: { type: 'string', description: 'Override the configured model for this call.' },
      },
      required: ['question'],
    },
  },
  {
    name: 'delegate',
    description: 'Implement a small function, helper or file with the LOCAL model: write the test first, then call this. '
      + 'The local model writes ONE file until YOUR test command passes, in an isolated git worktree. '
      + 'Returns only a PASS/FAIL verdict. Write the test first; the worker never sees test source, only parsed failures. '
      + 'Independent delegates can run in parallel. Read the diff before relying on the result.',
    inputSchema: {
      type: 'object',
      properties: {
        spec: { type: 'string', description: 'What the file must do. Resolve every ambiguity here.' },
        target_file: { type: 'string', description: 'File to create or modify, relative to the git root.' },
        test_command: { type: 'string', description: 'Shell command run in the worktree; exit 0 = pass.' },
        properties: {
          anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
          description: 'Invariants that must hold for every input, ideally one per gating test.',
        },
        context: { type: 'string', description: 'Exact API surface the file may use, verbatim (names, signatures, return shapes).' },
        test_files: { type: 'array', items: { type: 'string' }, description: 'Test files; the target may not be one of them.' },
        max_attempts: { type: 'integer', minimum: 1, maximum: 10, description: 'Generate/test rounds (default from config).' },
        model: { type: 'string', description: 'Override the configured model for this call.' },
        show_code: { type: 'boolean', description: 'Also return the code (default false: costs tokens).' },
        apply: { type: 'boolean', description: 'Copy the passing file into the checkout (default true).' },
      },
      required: ['spec', 'target_file', 'test_command'],
    },
  },
  {
    name: 'configure',
    description: 'Set up or change local-llm-worker (backend URL, models, search, which tools to use automatically via auto_use). No arguments: effective config, where each value comes from, '
      + 'config file paths, detected backend API, reachability and the backend\'s model list. '
      + 'With {set, scope}: merge keys into the user or project config file (null removes a key). '
      + 'Changes apply on the next call without a restart. Call this first on a new machine.',
    inputSchema: {
      type: 'object',
      properties: {
        set: {
          type: 'object',
          description: `Keys to change. Valid keys: ${CONFIG_KEYS.join(', ')}.`,
        },
        scope: { type: 'string', enum: ['user', 'project'], description: 'Which file to write (default user).' },
      },
    },
  },
];

const HANDLERS = { offload, research, delegate, configure };

function projectDir() {
  return process.env.CLAUDE_PROJECT_DIR || process.cwd();
}

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

// Heartbeat while a tool runs. Clients that reset their timeout on progress
// (and Claude Code's idle timeout) then never cut off a long delegate/research.
const PROGRESS_INTERVAL_MS = 15000;

// Sends notifications/progress for the client's progressToken, if it sent one.
function progressReporter(token) {
  if (token === undefined || token === null) return { report: undefined, stop() {} };
  let progress = 0;
  let last = 'working';
  let stopped = false;
  const report = (message) => {
    if (stopped) return;
    if (message) last = message;
    send({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: token, progress: ++progress, message: last } });
  };
  const timer = setInterval(report, PROGRESS_INTERVAL_MS);
  timer.unref();
  return { report, stop() { stopped = true; clearInterval(timer); } };
}

async function callTool(params) {
  const handler = HANDLERS[params?.name];
  if (!handler) {
    return { content: [{ type: 'text', text: `Unknown tool "${params?.name}"` }], isError: true };
  }
  const progress = progressReporter(params._meta?.progressToken);
  try {
    const text = await handler(params.arguments || {}, { cwd: projectDir(), progress: progress.report });
    return { content: [{ type: 'text', text }] };
  } catch (err) {
    return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
  } finally {
    progress.stop();
  }
}

async function handle(msg) {
  const { method, params } = msg;
  switch (method) {
    case 'initialize':
      return {
        protocolVersion: params?.protocolVersion || '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'local-llm-worker', version: VERSION },
      };
    case 'ping':
      return {};
    case 'tools/list':
      return { tools: TOOLS };
    case 'tools/call':
      return callTool(params);
    default: {
      const err = new Error(`Method not found: ${method}`);
      err.code = -32601;
      throw err;
    }
  }
}

function onLine(line) {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  // Notifications have no id and get no response.
  if (msg === null || typeof msg !== 'object' || msg.id === undefined || msg.id === null) return;
  // Not awaited: each request runs concurrently with the ones after it.
  handle(msg).then(
    (result) => send({ jsonrpc: '2.0', id: msg.id, result }),
    (err) => send({ jsonrpc: '2.0', id: msg.id, error: { code: Number.isInteger(err.code) ? err.code : -32603, message: err.message } }),
  );
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on('line', onLine);
