#!/usr/bin/env node
// LiteLLM per-request usage display for Claude Code Stop hook
// Fast path: displays cached stats immediately and spawns a detached background
// updater (~50ms). Slow path (--update): polls LiteLLM spend API and updates
// /tmp/litellm-stats.json for the status bar to read.


process.on('uncaughtException', () => process.exit(0));
process.on('unhandledRejection', () => process.exit(0));

const { readFileSync, writeFileSync } = await import('fs');

const isUpdate = process.argv.includes('--update');

// ── FAST PATH (stop hook) ──────────────────────────────────────────────────
// Display cached stats immediately, spawn background updater, exit in ~50ms.
if (!isUpdate) {
  // Drain stdin before doing anything (Claude Code pipes hook data here)
  let stdinData = '';
  try {
    if (!process.stdin.isTTY) {
      process.stdin.setEncoding('utf8');
      for await (const chunk of process.stdin) stdinData += chunk;
    }
  } catch {}

  // Show previous-turn cached stats immediately
  try {
    const cached = JSON.parse(readFileSync('/tmp/litellm-stats.json', 'utf8'));
    const { sessionTokIn = 0, sessionTokOut = 0 } = cached.session ?? {};
    const totalSpend = cached.total?.spend ?? null;
    const maxBudget = cached.total?.maxBudget ?? null;
    const sessionTok = sessionTokIn + sessionTokOut;
    if (sessionTok > 0) {
      const costStr = totalSpend != null ? '$' + totalSpend.toFixed(4) : '';
      const budgetStr = maxBudget != null ? ' / $' + maxBudget : '';
      const parts = [sessionTok + ' tok (↑' + sessionTokIn + ' ↓' + sessionTokOut + ')'];
      if (costStr) parts.push(costStr + budgetStr);
      process.stderr.write('\x1b[2m  ↳ ' + parts.join('  ') + '\x1b[0m\n');
    }
  } catch {}

  // Spawn detached background updater
  const base = process.env.ANTHROPIC_BASE_URL;
  const key = process.env.LITELLM_API_KEY || process.env.ANTHROPIC_API_KEY;
  if (base && key) {
    const { spawn } = await import('child_process');
    const child = spawn(process.execPath, [process.argv[1], '--update'], {
      detached: true,
      stdio: ['pipe', 'ignore', 'ignore'],
      env: process.env,
    });
    try { if (stdinData) child.stdin.write(stdinData); child.stdin.end(); } catch {}
    child.unref();
  }
  process.exit(0);
}

// ── SLOW PATH (--update, background) ──────────────────────────────────────
// Full API polling to update the cache. No stderr output (runs detached).

let hookData = {};
try {
  if (!process.stdin.isTTY) {
    let raw = '';
    process.stdin.setEncoding('utf8');
    for await (const chunk of process.stdin) raw += chunk;
    if (raw.trim()) hookData = JSON.parse(raw);
  }
} catch {}

const base = process.env.ANTHROPIC_BASE_URL;
const key = process.env.LITELLM_API_KEY || process.env.ANTHROPIC_API_KEY;
if (!base || !key) process.exit(0);

async function q(endpoint) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 8000);
  try {
    const r = await fetch(base + endpoint, {
      headers: { Authorization: 'Bearer ' + key },
      signal: ac.signal,
    });
    clearTimeout(timer);
    return r.ok ? r.json() : null;
  } catch { clearTimeout(timer); return null; }
}

const sessionStart = process.env.HYDRA_SESSION_START;

// Load previous stats — lastLogTs tells us the most recent log we've seen
let prevStats = {};
try { prevStats = JSON.parse(readFileSync('/tmp/litellm-stats.json', 'utf8')); } catch {}
const prevLastTs = prevStats.lastLogTs ?? null;

function getSessionLogs(raw) {
  const all = Array.isArray(raw) ? raw : [];
  if (!sessionStart) return all;
  const since = new Date(sessionStart).getTime();
  return all.filter(l => {
    const t = l.startTime ?? l.endTime;
    return t ? new Date(t).getTime() >= since : false;
  });
}

function newestTs(logs) {
  let max = null;
  for (const l of logs) {
    const t = l.endTime ?? l.startTime;
    if (!t) continue;
    const ms = new Date(t).getTime();
    if (max === null || ms > max) max = ms;
  }
  return max;
}

// Start /key/info fetch in parallel with log polling
const infoPromise = q('/key/info');

// (start_date was found to add latency with no filtering benefit).
// Session filtering is done client-side via getSessionLogs().
const MAX_WAIT = 9000;
const POLL_MS = 300;
const pollStart = Date.now();

let sessionLogs = [];
let newTurnLogs = [];

while (true) {
  const raw = await q('/spend/logs');
  sessionLogs = getSessionLogs(raw);
  const latestTs = newestTs(sessionLogs);

  if (latestTs !== null && (prevLastTs === null || latestTs > prevLastTs)) {
    // New log(s) appeared — isolate only the ones from this turn
    if (prevLastTs !== null) {
      newTurnLogs = sessionLogs.filter(l => {
        const t = l.endTime ?? l.startTime;
        return t ? new Date(t).getTime() > prevLastTs : false;
      });
    } else {
      // First run: pick the single most-recent log as the current turn
      const sorted = [...sessionLogs].sort((a, b) => {
        const ta = new Date(a.endTime ?? a.startTime ?? 0).getTime();
        const tb = new Date(b.endTime ?? b.startTime ?? 0).getTime();
        return tb - ta;
      });
      newTurnLogs = sorted.slice(0, 1);
    }
    break;
  }

  if (Date.now() - pollStart + POLL_MS >= MAX_WAIT) break;
  await new Promise(r => setTimeout(r, POLL_MS));
}

const info = await infoPromise;
const totalSpend = info?.info?.spend ?? null;
const maxBudget = info?.info?.max_budget ?? null;

// Session totals
let sessionTokIn = 0, sessionTokOut = 0, model = null, sessionCost = 0;
for (const l of sessionLogs) {
  sessionTokIn += l.prompt_tokens ?? 0;
  sessionTokOut += l.completion_tokens ?? 0;
  sessionCost += l.spend ?? l.response_cost ?? 0;
  if (l.model) model = l.model;
}

// Persist updated stats with the latest log timestamp for next run
const newLastTs = newestTs(sessionLogs);
try {
  writeFileSync('/tmp/litellm-stats.json', JSON.stringify({
    model,
    session: { sessionTokIn, sessionTokOut, sessionCost },
    total: { spend: totalSpend, maxBudget },
    lastLogTs: newLastTs,
    ts: Date.now(),
  }));
} catch {}
