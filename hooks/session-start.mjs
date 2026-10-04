// SessionStart hook: tells Claude which local tools to use on its own (config key
// auto_use). With many tools installed, Claude Code shows MCP tools by name only,
// and names alone don't say when to use them. Tools left out of auto_use still
// work when the user asks for them.

import { loadConfig, DEFAULTS } from '../src/worker.js';

const HINTS = {
  offload: '- offload: run noisy commands (test suites, builds) THROUGH it via `command` instead of Bash; same for logs or files >300 lines.',
  research: '- research: web lookups, instead of WebSearch/WebFetch.',
  delegate: '- delegate: functions/classes bigger than their tests, or several independent ones (run in parallel): write the tests, delegate the code.',
};

export function reminder(autoUse) {
  const lines = autoUse.filter((t) => HINTS[t]).map((t) => HINTS[t]);
  if (!lines.length) return '';
  return ['local-llm-worker: a local LLM does bulk work off your context (ToolSearch "local-llm-worker" if deferred).', ...lines].join('\n');
}

let autoUse = DEFAULTS.auto_use;
try {
  ({ config: { auto_use: autoUse } } = await loadConfig({ cwd: process.env.CLAUDE_PROJECT_DIR || process.cwd() }));
} catch {
  // A broken config file must not break session start; configure reports it.
}
const text = reminder(autoUse);
if (text) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text },
  }));
}
