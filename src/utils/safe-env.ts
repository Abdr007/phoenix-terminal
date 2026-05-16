export function safeEnvNumber(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

export function safeEnvBool(key: string, fallback: boolean): boolean {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  const v = raw.toLowerCase().trim();
  if (['true', '1', 'yes', 'on'].includes(v)) return true;
  if (['false', '0', 'no', 'off'].includes(v)) return false;
  return fallback;
}

export function safeEnvString(key: string, fallback: string): string {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  return raw;
}
