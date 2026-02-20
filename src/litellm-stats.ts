/**
 * LiteLLM usage statistics — host-side query helper.
 * Used by `hydra exec` for per-session cost summaries.
 */

export interface SpendLog {
  request_id?: string;
  model?: string;
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  response_cost?: number;
  spend?: number;
  startTime?: string;
  endTime?: string;
}

export interface KeyInfo {
  info?: {
    spend?: number;
    max_budget?: number;
    key_alias?: string;
  };
}

export async function fetchRecentLogs(
  baseUrl: string,
  apiKey: string,
  limit = 100,
): Promise<SpendLog[]> {
  try {
    const res = await fetch(`${baseUrl}/spend/logs?limit=${limit}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return [];
    const data = await res.json() as unknown;
    return Array.isArray(data) ? (data as SpendLog[]) : [];
  } catch {
    return [];
  }
}

export async function fetchKeyInfo(
  baseUrl: string,
  apiKey: string,
): Promise<KeyInfo | null> {
  try {
    const res = await fetch(`${baseUrl}/key/info`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(10000),
    });
    return res.ok ? (await res.json() as KeyInfo) : null;
  } catch {
    return null;
  }
}

export async function printSessionSummary(
  baseUrl: string,
  apiKey: string,
  sessionStart: Date,
): Promise<void> {
  const [logs, keyInfo] = await Promise.all([
    fetchRecentLogs(baseUrl, apiKey),
    fetchKeyInfo(baseUrl, apiKey),
  ]);

  const sessionLogs = logs.filter(l => {
    const t = l.startTime ?? l.endTime;
    return t ? new Date(t) >= sessionStart : false;
  });

  const totalSpend = keyInfo?.info?.spend;
  const maxBudget = keyInfo?.info?.max_budget;

  if (sessionLogs.length === 0 && totalSpend == null) return;

  const tokIn = sessionLogs.reduce((s, l) => s + (l.prompt_tokens ?? 0), 0);
  const tokOut = sessionLogs.reduce((s, l) => s + (l.completion_tokens ?? 0), 0);
  const cost = sessionLogs.reduce((s, l) => s + (l.spend ?? l.response_cost ?? 0), 0);

  const dim = '\x1b[2m';
  const reset = '\x1b[0m';

  console.log(`\n${dim}─────────────────────────────────────────`);
  console.log('  LiteLLM Session Summary');
  console.log('─────────────────────────────────────────');
  if (sessionLogs.length > 0) {
    console.log(`  Requests:     ${sessionLogs.length}`);
    console.log(`  Tokens:       ↑${tokIn.toLocaleString()} in  ↓${tokOut.toLocaleString()} out`);
    console.log(`  Session cost: $${cost.toFixed(6)}`);
  }
  if (totalSpend != null) {
    const budget = maxBudget != null
      ? `  ($${(maxBudget - totalSpend).toFixed(4)} remaining of $${maxBudget} budget)`
      : '';
    console.log(`  Project total: $${totalSpend.toFixed(4)}${budget}`);
  }
  console.log(`─────────────────────────────────────────${reset}`);
}
