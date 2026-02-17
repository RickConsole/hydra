/**
 * CLI output formatting helpers — ANSI codes, tables, status messages.
 * No dependencies.
 */

const isColorSupported = process.stdout.isTTY !== false;

function ansi(code: string, text: string): string {
  return isColorSupported ? `\x1b[${code}m${text}\x1b[0m` : text;
}

export function bold(text: string): string {
  return ansi('1', text);
}

export function dim(text: string): string {
  return ansi('2', text);
}

export function green(text: string): string {
  return ansi('32', text);
}

export function red(text: string): string {
  return ansi('31', text);
}

export function yellow(text: string): string {
  return ansi('33', text);
}

export function cyan(text: string): string {
  return ansi('36', text);
}

export function success(msg: string): void {
  console.log(`${green('✓')} ${msg}`);
}

export function error(msg: string): void {
  console.error(`${red('✗')} ${msg}`);
}

export function warn(msg: string): void {
  console.log(`${yellow('!')} ${msg}`);
}

/**
 * Print an aligned table with headers and rows.
 * Automatically calculates column widths.
 */
export function table(headers: string[], rows: string[][]): void {
  const widths = headers.map((h, i) => {
    const colValues = rows.map(r => (r[i] || '').length);
    return Math.max(h.length, ...colValues);
  });

  const header = headers.map((h, i) => bold(h.padEnd(widths[i]))).join('  ');
  const separator = widths.map(w => dim('─'.repeat(w))).join('  ');

  console.log(header);
  console.log(separator);
  for (const row of rows) {
    const line = row.map((cell, i) => (cell || '').padEnd(widths[i])).join('  ');
    console.log(line);
  }
}
