/**
 * Shared helpers and types for command handlers under src/tools/.
 *
 * Lives in its own file so split tool modules (tools-mm.ts, tools-journal.ts,
 * tools-examples.ts) can import without circular-dep risk against the main
 * registry (phoenix-tools.ts).
 */
import { WalletManager } from '../wallet/walletManager.js';
import { RpcManager } from '../network/rpc-manager.js';
import type { Watcher } from '../phoenix/watcher.js';
import type { Maker } from '../phoenix/maker.js';
import type { MultiMarketMaker } from '../phoenix/multi-maker.js';

/** Container for ambient state the tools need. */
export interface AppCtx {
  wallet: WalletManager;
  rpc: RpcManager;
  activeWatcher: Watcher | null;
  activeMaker: Maker | null;
  activeMultiMaker: MultiMarketMaker | null;
  /** Runtime-mutable mode flag — defaults to ctx.simulationMode but can be toggled via `mode` command. */
  simulationMode: boolean;
  /** Callback invoked when mode changes so the REPL prompt can refresh. */
  onModeChange?: (newMode: boolean) => void;
}

/**
 * Look up the value following a `--flag` token and parse it as a finite number.
 * Returns the fallback when the flag is absent. Throws when the flag is present
 * but the next token is missing, starts with `--`, or doesn't parse to a
 * finite positive (or zero) number — prevents `--max-slippage --use-jito`
 * from silently producing NaN and disabling the slippage check.
 *
 * @param positive — when true (default), the parsed value must be ≥ 0.
 */
export function flagNum(args: string[], flag: string, fallback: number, positive = true): number {
  const idx = args.indexOf(flag);
  if (idx < 0) return fallback;
  const next = args[idx + 1];
  if (next === undefined || next.startsWith('--')) {
    throw new Error(`${flag} requires a numeric value (got ${next === undefined ? 'nothing' : `"${next}"`}).`);
  }
  const n = Number(next);
  if (!Number.isFinite(n)) {
    throw new Error(`${flag} expects a number, got "${next}".`);
  }
  if (positive && n < 0) {
    throw new Error(`${flag} must be ≥ 0, got ${n}.`);
  }
  return n;
}

/** Same as flagNum but parses an integer; rejects fractional values. */
export function flagInt(args: string[], flag: string, fallback: number, positive = true): number {
  const n = flagNum(args, flag, fallback, positive);
  if (!Number.isInteger(n)) {
    throw new Error(`${flag} expects an integer, got ${n}.`);
  }
  return n;
}
