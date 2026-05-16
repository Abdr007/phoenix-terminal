#!/usr/bin/env node
import { runTerminal } from './cli/terminal.js';

process.on('uncaughtException', (err) => {
  console.error('[fatal] uncaught exception:', err);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  console.error('[fatal] unhandled rejection:', reason);
  process.exit(1);
});

runTerminal().catch((err) => {
  console.error('[fatal] terminal crashed:', err);
  process.exit(1);
});
