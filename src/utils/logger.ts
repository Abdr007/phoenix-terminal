import { appendFileSync, mkdirSync, existsSync, statSync, renameSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import chalk from 'chalk';

type Level = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const MAX_LOG_BYTES = 10 * 1024 * 1024;

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/sk-ant-[A-Za-z0-9_-]+/g, 'sk-ant-***'],
  [/gsk_[A-Za-z0-9]+/g, 'gsk_***'],
  [/api[_-]?key=([A-Za-z0-9_-]{8,})/gi, 'api_key=***'],
  [/bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer ***'],
];

function scrub(msg: string): string {
  let out = msg;
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

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
