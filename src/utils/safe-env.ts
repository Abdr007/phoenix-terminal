/**
 * Typed env-var readers with explicit fallback.
 *
 * When a value is present but unrecognized (e.g. typo: `SIMULATION_MODE=truee`),
 * we log a one-time WARN on first read so the user notices instead of silently
 * getting the fallback. Critical for safety env vars where the fallback might
 * be "live trading".
 */
const _warnedKeys = new Set<string>();
function warnOnce(key: string, raw: string, expected: string, used: string): void {
  if (_warnedKeys.has(key)) return;
  _warnedKeys.add(key);
  // Use console.warn directly — getLogger() pulls in fs/path/dotenv which can
  // cause circular initialization issues since config (which depends on this)
  // is loaded very early.
  console.warn(`[safe-env] ${key}="${raw}" not recognized (expected ${expected}); using ${used}`);
}

export function safeEnvNumber(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (Number.isFinite(n)) return n;
  warnOnce(key, raw, 'a finite number', `fallback ${fallback}`);
  return fallback;
}

export function safeEnvBool(key: string, fallback: boolean): boolean {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  const v = raw.toLowerCase().trim();
  if (['true', '1', 'yes', 'on'].includes(v)) return true;
  if (['false', '0', 'no', 'off'].includes(v)) return false;
  warnOnce(key, raw, 'true|false|yes|no|on|off|0|1', `fallback ${fallback}`);
  return fallback;
}

export function safeEnvString(key: string, fallback: string): string {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  return raw;
}
