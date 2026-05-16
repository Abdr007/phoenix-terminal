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
      const segments = line.split('&&').map((s) => s.trim()).filter(Boolean);
      for (const seg of segments) {
        const firstWord = seg.split(/\s+/)[0];
        const looksLikeCommand = engine.has(firstWord);
        let resolved = seg;
        if (!looksLikeCommand && getAiInterpreter()) {
          resolved = `ai ${seg}`;
        }
        const result = await engine.run(resolved);
        if (result) console.log(result);
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

  rl.on('close', async () => {
    if (ctx.activeMaker) await ctx.activeMaker.stop();
    if (ctx.activeMultiMaker) await ctx.activeMultiMaker.stop();
    if (ctx.activeWatcher) await ctx.activeWatcher.stop();
    rpc.stopMonitor();
    process.exit(0);
  });
}

function completer(engine: ToolEngine): (line: string) => [string[], string] {
  return (line) => {
    const cmds = engine.list().map((t) => t.name).concat(['SOL/USDC', 'SOL/USDT', 'JitoSOL/USDC', 'JitoSOL/SOL', 'mSOL/SOL']);
    const hits = cmds.filter((c) => c.startsWith(line));
    return [hits.length ? hits : cmds, line];
  };
}
