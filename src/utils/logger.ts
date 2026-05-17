import { appendFileSync, mkdirSync, existsSync, statSync, renameSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import chalk from 'chalk';

type Level = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const MAX_LOG_BYTES = 10 * 1024 * 1024;

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  // Anthropic, Groq, generic api_key=, Bearer tokens
  [/sk-ant-[A-Za-z0-9_-]+/g, 'sk-ant-***'],
  [/gsk_[A-Za-z0-9]+/g, 'gsk_***'],
  [/api[_-]?key=([A-Za-z0-9_-]{8,})/gi, 'api_key=***'],
  [/bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer ***'],
  // OpenAI / Anthropic short-form keys
  [/sk-proj-[A-Za-z0-9_-]+/g, 'sk-proj-***'],
  [/sk-[A-Za-z0-9]{40,}/g, 'sk-***'],
  // Helius RPC URL pattern: `helius-rpc.com/<uuid>` and `<uuid>.helius-rpc.com`
  // both leak the API key via the URL itself.
  [/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.helius-rpc\.com/gi, '***.helius-rpc.com'],
  [/(helius-rpc\.com\/v?\d*\/?)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '$1***'],
  // GitHub PATs, AWS access keys
  [/gh[pousr]_[A-Za-z0-9_]{36,}/g, 'gh***_***'],
  [/AKIA[0-9A-Z]{16}/g, 'AKIA***'],
];

function scrub(msg: string): string {
  let out = msg;
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

/** @internal — exported for testability. Same as the module-private `scrub`. */
export const scrubForTests = scrub;

class Logger {
  private level: Level;
  private filePath: string | null;

  constructor() {
    this.level = (process.env.LOG_LEVEL as Level) ?? 'info';
    if (!LEVEL_ORDER[this.level]) this.level = 'info';
    const raw = process.env.LOG_FILE;
    this.filePath = raw ? raw.replace(/^~/, process.env.HOME ?? '~') : null;
    if (this.filePath) this.initFile(this.filePath);
  }

  private initFile(path: string): void {
    try {
      const dir = dirname(path);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
      if (!existsSync(path)) writeFileSync(path, '', { mode: 0o600 });
    } catch {
      this.filePath = null;
    }
  }

  private rotate(path: string): void {
    try {
      const size = statSync(path).size;
      if (size > MAX_LOG_BYTES) {
        renameSync(path, path + '.old');
        writeFileSync(path, '', { mode: 0o600 });
      }
    } catch {
      /* best effort */
    }
  }

  private write(level: Level, module: string, msg: string): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.level]) return;
    const scrubbed = scrub(msg);
    const ts = new Date().toISOString();
    const line = `${ts} [${level.toUpperCase()}] [${module}] ${scrubbed}`;

    const color = level === 'error' ? chalk.red : level === 'warn' ? chalk.yellow : level === 'debug' ? chalk.gray : chalk.cyan;
    console.log(color(`[${level.toUpperCase()}]`) + chalk.gray(` [${module}] `) + scrubbed);

    if (this.filePath) {
      try {
        this.rotate(this.filePath);
        appendFileSync(this.filePath, line + '\n');
      } catch {
        /* best effort */
      }
    }
  }

  debug(module: string, msg: string): void { this.write('debug', module, msg); }
  info(module: string, msg: string): void { this.write('info', module, msg); }
  warn(module: string, msg: string): void { this.write('warn', module, msg); }
  error(module: string, msg: string): void { this.write('error', module, msg); }
}

let _logger: Logger | null = null;
export function getLogger(): Logger {
  if (!_logger) _logger = new Logger();
  return _logger;
}
