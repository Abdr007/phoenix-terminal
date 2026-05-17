import { renderError, renderInfo } from '../cli/renderer.js';
import { theme } from '../cli/theme.js';

export type ToolHandler = (args: string[]) => Promise<string | void>;

export interface ToolDef {
  name: string;
  summary: string;
  usage: string;
  handler: ToolHandler;
  aliases?: string[];
  examples?: string[];
}

export class ToolEngine {
  private tools = new Map<string, ToolDef>();
  private aliasMap = new Map<string, string>();

  register(tool: ToolDef): void {
    this.tools.set(tool.name, tool);
    if (tool.aliases) {
      for (const a of tool.aliases) this.aliasMap.set(a, tool.name);
    }
  }

  has(name: string): boolean {
    return this.tools.has(name) || this.aliasMap.has(name);
  }

  list(): ToolDef[] {
    return Array.from(this.tools.values()).sort((a, b) => a.name.localeCompare(b.name));
  }

  async run(line: string): Promise<string | void> {
    const trimmed = line.trim();
    if (!trimmed) return;
    const parts = trimmed.split(/\s+/);
    const name = parts[0] ?? '';
    const args = parts.slice(1);
    const resolved = this.aliasMap.get(name) ?? name;
    const tool = this.tools.get(resolved);
    if (!tool) {
      return renderError(`unknown command: ${name}. Type 'help' for the menu.`);
    }
    try {
      return await tool.handler(args);
    } catch (e) {
      return renderError(`${name}: ${(e as Error).message}`);
    }
  }

  helpText(): string {
    const lines: string[] = [renderInfo(`${this.tools.size} commands available:\n`)];
    for (const t of this.list()) {
      lines.push(`  ${theme.highlight(t.name.padEnd(12))} ${theme.muted(t.summary)}`);
      lines.push(`  ${' '.repeat(14)}${theme.dim(t.usage)}`);
    }
    return lines.join('\n');
  }
}
