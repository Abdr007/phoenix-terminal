import * as readline from 'readline';
import { existsSync, mkdirSync, readFileSync, appendFileSync } from 'fs';
import { dirname, join } from 'path';
import { homedir } from 'os';
import { ToolEngine } from '../tools/engine.js';
import { registerPhoenixTools, AppCtx } from '../tools/phoenix-tools.js';
import { initRpcManager } from '../network/rpc-manager.js';
import { WalletManager } from '../wallet/walletManager.js';
import { initSigningGuard } from '../security/signing-guard.js';
import { initPhoenixClient } from '../phoenix/client.js';
import { closeJournal } from '../phoenix/journal.js';
import { initAiInterpreter, getAiInterpreter } from '../ai/interpreter.js';
import { loadConfig } from '../config/index.js';
import { PHOENIX_BANNER, theme } from './theme.js';
import { renderError, renderInfo, renderWarn } from './renderer.js';

export async function runTerminal(): Promise<void> {
  const cfg = loadConfig();

  // ─── Bootstrap ──────────────────────────────────────────────────────────────
  const rpcEndpoints = [{ url: cfg.rpcUrl, label: 'primary' }, ...cfg.backupRpcs.map((u, i) => ({ url: u, label: `backup-${i + 1}` }))];
  const rpc = initRpcManager(rpcEndpoints);
  rpc.startMonitor();

  const wallet = new WalletManager(rpc.connection);
  rpc.onConnectionChange((conn) => wallet.setConnection(conn));

  initSigningGuard({
    maxNotionalPerOrder: cfg.maxNotionalPerOrder,
    maxOrdersPerMinute: cfg.maxOrdersPerMinute,
    minDelayBetweenOrdersMs: cfg.minDelayBetweenOrdersMs,
  });

  initPhoenixClient(rpc.connection);

  if (existsSync(cfg.walletPath.replace(/\/$/, ''))) {
    try {
      wallet.loadFromFile(cfg.walletPath);
    } catch (e) {
      console.log(renderWarn(`wallet auto-load failed: ${(e as Error).message}`));
    }
  }

  const engine = new ToolEngine();
  let modeFlag = cfg.simulationMode; // closure-captured for onModeChange callback
  const ctx: AppCtx = {
    wallet,
    rpc,
    activeWatcher: null,
    activeMaker: null,
    activeMultiMaker: null,
    simulationMode: cfg.simulationMode,
    onModeChange: (newMode) => { modeFlag = newMode; /* prompt() reads ctx.simulationMode directly */ },
  };
  registerPhoenixTools(engine, ctx);

  const ai = initAiInterpreter(engine);

  // Auto-halt any active makers when the wallet disconnects (manual or timeout)
  wallet.onDisconnect(async () => {
    if (ctx.activeMaker) {
      console.log(renderWarn('wallet disconnected — stopping active maker'));
      try { await ctx.activeMaker.stop(); } catch { /* ignore */ }
      ctx.activeMaker = null;
    }
    if (ctx.activeMultiMaker) {
      console.log(renderWarn('wallet disconnected — stopping multi-maker'));
      try { await ctx.activeMultiMaker.stop(); } catch { /* ignore */ }
      ctx.activeMultiMaker = null;
    }
  });

  // ─── Banner ─────────────────────────────────────────────────────────────────
  console.log(PHOENIX_BANNER);

  // ─── Startup mode picker ────────────────────────────────────────────────────
  // Skipped when:
  //   - --mode {paper|live} flag passed
  //   - $PHOENIX_MODE env set
  //   - non-TTY stdin (piped / CI)
  //   - $PHOENIX_NONINTERACTIVE=1
  const cliModeArg = process.argv.find((a) => a === '--mode' || a === '--paper' || a === '--live');
  const envMode = (process.env.PHOENIX_MODE ?? '').toLowerCase();
  const skipPicker =
    process.env.PHOENIX_NONINTERACTIVE === '1' ||
    !process.stdin.isTTY ||
    !!cliModeArg ||
    envMode === 'paper' || envMode === 'live';
  if (envMode === 'live') ctx.simulationMode = false;
  else if (envMode === 'paper') ctx.simulationMode = true;
  if (cliModeArg === '--live') ctx.simulationMode = false;
  if (cliModeArg === '--paper') ctx.simulationMode = true;
  if (cliModeArg === '--mode') {
    const v = process.argv[process.argv.indexOf('--mode') + 1]?.toLowerCase();
    if (v === 'live') ctx.simulationMode = false;
    else if (v === 'paper') ctx.simulationMode = true;
  }

  if (!skipPicker) {
    const chosen = await askStartupMode(cfg.simulationMode);
    ctx.simulationMode = chosen === 'paper';
  }

  console.log(`  ${theme.muted('network:')} ${cfg.network}    ${theme.muted('rpc:')} ${rpc.active.label}    ${theme.muted('mode:')} ${ctx.simulationMode ? theme.success('paper') : theme.error('LIVE')}    ${theme.muted('(toggle: "mode live")')}`);
  if (wallet.hasAddress) {
    console.log(`  ${theme.muted('wallet:')} ${theme.value(wallet.address!)}  ${wallet.isReadOnly ? theme.warning('(read-only)') : theme.success('(signing)')}`);
  } else {
    console.log(`  ${theme.muted('wallet:')} ${theme.warning('not connected — set WALLET_PATH or use load-wallet command')}`);
  }
  const aiHint = ai ? theme.muted(' · AI enabled — prefix with ') + theme.highlight('ai ') + theme.muted('for natural language') : '';
  console.log(`  ${theme.muted('Type ')}${theme.highlight('help')}${theme.muted(' for commands. Try: ')}${theme.accent('markets, book SOL/USDC, watch, arb')}${aiHint}\n`);

  // ─── REPL ───────────────────────────────────────────────────────────────────
  const historyPath = join(homedir(), '.phoenix', 'history');
  try {
    if (!existsSync(dirname(historyPath))) mkdirSync(dirname(historyPath), { recursive: true, mode: 0o700 });
  } catch { /* ignore */ }
  let priorHistory: string[] = [];
  try {
    if (existsSync(historyPath)) {
      priorHistory = readFileSync(historyPath, 'utf-8').split('\n').filter(Boolean).slice(-500).reverse();
    }
  } catch { /* ignore */ }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
    historySize: 500,
    completer: completer(engine),
  });
  // Seed in-memory history with prior session lines (readline expects newest first)
  // @ts-expect-error Node's readline has .history but it's not in the typings
  rl.history = priorHistory;

  const prompt = () => {
    const tag = ctx.simulationMode ? theme.success('paper') : theme.error('LIVE');
    rl.setPrompt(`${theme.primary('phoenix')} ${theme.muted('(' + tag + ')')} ${theme.muted('›')} `);
    rl.prompt();
  };
  void modeFlag; // silence unused — closure exists for future use

  prompt();

  rl.on('line', async (raw) => {
    const line = raw.trim();
    if (!line) { prompt(); return; }
    wallet.resetIdle();
    // Persist to history file (newest-line-last)
    try { appendFileSync(historyPath, line + '\n'); } catch { /* ignore */ }
    try {
      // Support `&&`-joined multi-step prompts (e.g. "mode live && wallet use dvv")
      // BUT refuse chains that contain destructive segments — one-line
      // `mode live && buy SOL 1 --ioc` chains are too easy to fat-finger and
      // too dangerous to allow without an explicit second confirmation.
      const segments = line.split('&&').map((s) => s.trim()).filter(Boolean);
      const DESTRUCTIVE_HEADS = new Set([
        'buy','sell','cancel','cancel-id','cancel-top','reduce','ladder','arb',
        'mm','mm-start','mm-stop','mm-multi','deposit','withdraw','free-funds',
        'claim-seat','evict','mode','wallet',
      ]);
      const hasDestructive = segments.some((s) => DESTRUCTIVE_HEADS.has(s.split(/\s+/)[0] ?? ''));
      if (segments.length > 1 && hasDestructive) {
        console.log(renderError('chained "&&" commands are not allowed when any segment is destructive. Run them one at a time.'));
      } else {
        for (const seg of segments) {
          const firstWord = seg.split(/\s+/)[0] ?? '';
          const looksLikeCommand = engine.has(firstWord);
          let resolved = seg;
          if (!looksLikeCommand && getAiInterpreter()) {
            resolved = `ai ${seg}`;
          }
          const result = await engine.run(resolved);
          if (result) console.log(result);
        }
      }
    } catch (e) {
      console.log(renderError((e as Error).message));
    }
    prompt();
  });

  rl.on('SIGINT', () => {
    console.log('\n' + renderInfo('use "quit" to exit.'));
    prompt();
  });

  // Shutdown sequence — extracted so the same cleanup runs on both `rl.on('close')`
  // (interactive exit via `quit`) AND on SIGTERM (process-level kill).
  let shuttingDown = false;
  const gracefulShutdown = async (signal: string, exitCode = 0): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (signal !== 'close') {
      console.log('\n' + renderInfo(`received ${signal} — shutting down cleanly…`));
    }
    try { if (ctx.activeMaker) await ctx.activeMaker.stop(); } catch { /* */ }
    try { if (ctx.activeMultiMaker) await ctx.activeMultiMaker.stop(); } catch { /* */ }
    try { if (ctx.activeWatcher) await ctx.activeWatcher.stop(); } catch { /* */ }
    try { await ctx.wallet.disconnect(); } catch { /* */ }
    rpc.stopMonitor();
    closeJournal();
    process.exit(exitCode);
  };

  rl.on('close', () => { void gracefulShutdown('close', 0); });
  // SIGTERM is what `kill <pid>` and most process managers send. Without
  // this handler Node would default-exit immediately, leaving the journal
  // mid-write, makers still resting orders on-chain, and the keypair secret
  // unzeroed in memory.
  process.on('SIGTERM', () => { void gracefulShutdown('SIGTERM', 0); });
  process.on('SIGHUP', () => { void gracefulShutdown('SIGHUP', 0); });
}

function completer(engine: ToolEngine): (line: string) => [string[], string] {
  return (line) => {
    const cmds = engine.list().map((t) => t.name).concat(['SOL/USDC', 'SOL/USDT', 'JitoSOL/USDC', 'JitoSOL/SOL', 'mSOL/SOL']);
    const hits = cmds.filter((c) => c.startsWith(line));
    return [hits.length ? hits : cmds, line];
  };
}

/**
 * Startup picker — prompts the user for paper vs LIVE before the REPL starts.
 * Default (Enter without input) = paper. Typing `2` or `live` selects LIVE.
 * Uses readline with a one-shot question — non-TTY callers should set
 * PHOENIX_NONINTERACTIVE=1 to skip this entirely.
 */
async function askStartupMode(defaultPaper: boolean): Promise<'paper' | 'live'> {
  return new Promise<'paper' | 'live'>((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const def = defaultPaper ? 'paper' : 'live';
    process.stdout.write(
      '  ' + theme.section('Choose mode') + '\n' +
      '    ' + theme.success('1) paper') + theme.muted('  — simulation, no on-chain action  (default)') + '\n' +
      '    ' + theme.error('2) LIVE') + theme.muted('   — REAL transactions, REAL funds') + '\n' +
      '  ' + theme.muted(`> [Enter for ${def}, type 1/paper or 2/live] `),
    );
    const onLine = (raw: string) => {
      rl.close();
      const v = raw.trim().toLowerCase();
      if (v === '2' || v === 'live' || v === 'l') resolve('live');
      else if (v === '1' || v === 'paper' || v === 'p' || v === '') resolve(defaultPaper ? 'paper' : 'live');
      else {
        process.stdout.write(theme.warning(`  unrecognized "${raw}" — defaulting to ${def}\n`));
        resolve(defaultPaper ? 'paper' : 'live');
      }
    };
    rl.once('line', onLine);
    rl.once('close', () => resolve(defaultPaper ? 'paper' : 'live'));
  });
}
