import chalk from 'chalk';

/**
 * Phoenix Terminal Theme — clean professional trading-terminal palette.
 *
 * Structurally modeled after bolt-terminal: muted gray for chrome,
 * bright white for values, brand-color accent for headers/links.
 * Phoenix's brand accent is ember orange (#FF6B35).
 */

const ACCENT = chalk.hex('#FF6B35');           // ember orange — Phoenix brand
const ACCENT_BOLD = chalk.hex('#FF6B35').bold;
const ACCENT2 = chalk.hex('#FFB627');          // sunrise yellow (secondary)
const MUTED = chalk.hex('#6B7B73');
const TEXT = chalk.hex('#B8C1BB');
const BRIGHT = chalk.white;
const SUCCESS = chalk.hex('#22C55E');
const WARNING = chalk.hex('#FBBF24');
const ERROR = chalk.hex('#EF4444');
const BID = chalk.hex('#22C55E');
const ASK = chalk.hex('#EF4444');

function termWidth(): number {
  return Math.min(process.stdout.columns || 80, 100);
}

export const theme = {
  // ─── Backwards-compat aliases (callable as function or used like object) ───
  primary: ACCENT,
  accent: ACCENT2,
  muted: MUTED,
  dim: MUTED,
  success: SUCCESS,
  warning: WARNING,
  error: ERROR,
  bid: BID,
  ask: ASK,
  label: MUTED,
  value: BRIGHT,
  highlight: ACCENT_BOLD,
  text: TEXT,
  rule: MUTED('─'),

  // ─── Structural ─────────────────────────────────────────────────────────
  /** Top-of-output section header, like POSITIONS or PORTFOLIO SUMMARY */
  header(text: string): string {
    return ACCENT_BOLD(text);
  },
  section(text: string): string {
    return chalk.bold(TEXT(text));
  },
  /** Horizontal separator at a specific width */
  separator(width = 40): string {
    return MUTED('─'.repeat(width));
  },
  /** Full-width separator matching terminal */
  fullSeparator(): string {
    return MUTED('─'.repeat(termWidth()));
  },
  /** Subtle key label (right-aligned column hint) */
  key(text: string): string {
    return MUTED(text);
  },
};

export const PHOENIX_BANNER = `
${ACCENT('  ____  _                      _')}
${ACCENT(' |  _ \\| |__   ___   ___ _ __ (_)_  __')}
${ACCENT(' | |_) | \'_ \\ / _ \\ / _ \\ \'_ \\| \\ \\/ /')}
${ACCENT(' |  __/| | | | (_) |  __/ | | | |>  <')}
${ACCENT(' |_|   |_| |_|\\___/ \\___|_| |_|_/_/\\_\\')}
${ACCENT2(' ─────────── T E R M I N A L ───────────')}
`;
