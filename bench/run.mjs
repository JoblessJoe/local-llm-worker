#!/usr/bin/env node
// Reliability benchmark for `delegate` against a real backend.
//
//   node bench/run.mjs --models qwen3-coder:30b,granite4.1:8b --runs 5 --parallel 4
//
// Each run gets a fresh temp git repo with the task's fixture: source files committed, tests
// left uncommitted (as when Claude has just written them). Results go to bench/results/*.jsonl
// and a summary table is printed. Env vars (LLW_BASE_URL, LLW_API, ...) configure the backend.

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { delegate, run } from '../src/worker.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => {
  if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1]?.startsWith('--') || all[i + 1] === undefined ? 'true' : all[i + 1]]);
  return acc;
}, []));

const models = (args.models || process.env.LLW_MODEL || '').split(',').filter(Boolean);
if (!models.length) throw new Error('--models a,b (or LLW_MODEL) is required');
const runs = Number(args.runs || 5);
const parallel = Number(args.parallel || 4);
const python = args.python || 'python3';
const allTasks = (await fs.readdir(path.join(here, 'tasks'))).sort();
const tasks = args.tasks ? args.tasks.split(',') : allTasks;
const outFile = args.out || path.join(here, 'results', `${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`);
await fs.mkdir(path.dirname(outFile), { recursive: true });

async function sh(cwd, ...cmd) {
  const r = await run(cmd[0], cmd.slice(1), { cwd });
  if (r.code !== 0) throw new Error(`${cmd.join(' ')}: ${r.stderr}`);
  return r.stdout;
}

async function copyDir(src, dst) {
  await fs.mkdir(dst, { recursive: true });
  for (const e of await fs.readdir(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) await copyDir(s, d);
    else await fs.copyFile(s, d);
  }
}

async function makeRepo(task) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'llw-bench-')));
  await sh(root, 'git', 'init', '-q');
  await sh(root, 'git', 'config', 'user.email', 'bench@example.com');
  await sh(root, 'git', 'config', 'user.name', 'bench');
  await fs.writeFile(path.join(root, 'package.json'), '{"type":"module"}\n');
  await copyDir(path.join(here, 'tasks', task, 'files'), root);
  // Commit everything except tests, which stay uncommitted.
  await sh(root, 'git', 'add', '.');
  for (const t of ['test', 'tests']) await run('git', ['rm', '-r', '-q', '--cached', '--ignore-unmatch', t], { cwd: root });
  await sh(root, 'git', 'commit', '-q', '-m', 'fixture');
  return root;
}

function parse(text) {
  const m = /^(PASS|FAIL) · attempt (\d+)\/(\d+)/m.exec(text);
  const tok = /(\d+) tokens generated locally/.exec(text);
  const wt = /git worktree remove --force (\S+)/.exec(text);
  return { verdict: m ? m[1] : 'UNKNOWN', attempt: m ? Number(m[2]) : null, out_tok: tok ? Number(tok[1]) : null, keptWorktree: wt?.[1] };
}

async function one(model, task, n) {
  const spec = JSON.parse(await fs.readFile(path.join(here, 'tasks', task, 'task.json'), 'utf8'));
  spec.test_command = spec.test_command.replace('{python}', python);
  const root = await makeRepo(task);
  const env = { ...process.env, LLW_MODEL: model, LLW_LOG_PATH: '' };
  const started = Date.now();
  let rec;
  try {
    const text = await delegate(spec, { cwd: root, env });
    const p = parse(text);
    if (p.keptWorktree) await run('git', ['worktree', 'remove', '--force', p.keptWorktree], { cwd: root });
    const left = (await sh(root, 'git', 'worktree', 'list', '--porcelain')).split('\n').filter((l) => l.startsWith('worktree ')).length - 1;
    rec = { model, task, run: n, verdict: p.verdict, attempt: p.attempt, out_tok: p.out_tok, leaked_worktrees: left, failure: p.verdict === 'FAIL' ? text.split('\n').slice(2).join('\n').slice(0, 600) : undefined };
  } catch (err) {
    rec = { model, task, run: n, verdict: 'ERROR', error: err.message.slice(0, 600) };
  }
  rec.wall_s = Number(((Date.now() - started) / 1000).toFixed(1));
  await fs.rm(root, { recursive: true, force: true });
  await fs.appendFile(outFile, JSON.stringify(rec) + '\n');
  process.stderr.write(`${rec.verdict.padEnd(5)} ${model} ${task}#${n} attempt=${rec.attempt ?? '-'} ${rec.wall_s}s${rec.error ? ` ${rec.error.slice(0, 120)}` : ''}\n`);
  return rec;
}

async function pool(jobs, size) {
  const results = [];
  let next = 0;
  await Promise.all(Array.from({ length: size }, async () => {
    while (next < jobs.length) results.push(await jobs[next++]());
  }));
  return results;
}

const all = [];
for (const model of models) {
  // One model at a time so the backend isn't swapping models between requests.
  const jobs = [];
  for (let n = 1; n <= runs; n++) for (const task of tasks) jobs.push(() => one(model, task, n));
  const t0 = Date.now();
  all.push(...await pool(jobs, parallel));
  process.stderr.write(`== ${model}: ${((Date.now() - t0) / 1000).toFixed(0)}s for ${jobs.length} runs\n`);
}

const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0; };
console.log(`\nresults: ${outFile}\n`);
console.log('| model | task | pass@1 | pass@3 | errors | median wall |');
console.log('|---|---|---|---|---|---|');
for (const model of models) {
  for (const task of tasks) {
    const rs = all.filter((r) => r.model === model && r.task === task);
    const p1 = rs.filter((r) => r.verdict === 'PASS' && r.attempt === 1).length;
    const p3 = rs.filter((r) => r.verdict === 'PASS').length;
    const errs = rs.filter((r) => r.verdict === 'ERROR').length;
    console.log(`| ${model} | ${task} | ${p1}/${rs.length} | ${p3}/${rs.length} | ${errs} | ${median(rs.map((r) => r.wall_s))}s |`);
  }
}
const leaks = all.reduce((n, r) => n + (r.leaked_worktrees || 0), 0);
console.log(`\nleaked worktrees: ${leaks}`);
