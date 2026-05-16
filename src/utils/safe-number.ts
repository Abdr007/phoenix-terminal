export function safeNumber(v: unknown, fallback = 0): number {
  if (typeof v !== 'number') return fallback;
  return Number.isFinite(v) ? v : fallback;
}

export function clamp(v: number, min: number, max: number): number {
  if (!Number.isFinite(v)) return min;
  return Math.min(Math.max(v, min), max);
}
