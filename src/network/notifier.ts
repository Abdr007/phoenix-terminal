/**
 * Multi-channel notifications — Discord / Telegram / Slack / generic webhook.
 *
 * Fire-and-forget: every notify() returns immediately; failures are logged but
 * never block the trading pipeline. All channels configured via env:
 *   DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/.../...
 *   SLACK_WEBHOOK_URL=https://hooks.slack.com/services/.../.../...
 *   TELEGRAM_BOT_TOKEN=...   TELEGRAM_CHAT_ID=...
 *   ALERT_WEBHOOK_URL=https://your-endpoint.example/alerts   (generic JSON POST)
 *
 * Event types: fill, mm_started, mm_stopped, mm_error, oracle_divergence, low_balance, custom.
 */

import { getLogger } from '../utils/logger.js';
import { safeEnvString } from '../utils/safe-env.js';

const TIMEOUT_MS = 5_000;

export type NotifySeverity = 'info' | 'success' | 'warning' | 'error';

export interface NotifyEvent {
  kind: 'fill' | 'mm_started' | 'mm_stopped' | 'mm_error' | 'oracle_divergence' | 'low_balance' | 'custom';
  severity: NotifySeverity;
  title: string;
  body: string;
  /** Optional structured fields (k/v) shown by channels that support it (Discord/Slack). */
  fields?: Record<string, string | number>;
  /** Optional URL (e.g. Solscan tx link) — surfaces as a clickable action where supported. */
  link?: { label: string; url: string };
}

interface Channel {
  name: string;
  send(e: NotifyEvent): Promise<void>;
}

const SEVERITY_COLOR_HEX: Record<NotifySeverity, number> = {
  info: 0x6b7b73,
  success: 0x22c55e,
  warning: 0xfbbf24,
  error: 0xef4444,
};

const SEVERITY_EMOJI: Record<NotifySeverity, string> = {
  info: 'ℹ️',
  success: '✅',
  warning: '⚠️',
  error: '🚨',
};

async function postJSON(url: string, body: unknown, channel: string): Promise<void> {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      getLogger().warn('notifier', `${channel}: HTTP ${res.status}`);
    }
  } catch (e) {
    getLogger().debug('notifier', `${channel}: ${(e as Error).message}`);
  } finally {
    clearTimeout(to);
  }
}

class DiscordChannel implements Channel {
  name = 'discord';
  constructor(private url: string) {}
  async send(e: NotifyEvent): Promise<void> {
    const fields = e.fields ? Object.entries(e.fields).map(([k, v]) => ({ name: k, value: String(v), inline: true })) : undefined;
    const embed: Record<string, unknown> = {
      title: `${SEVERITY_EMOJI[e.severity]} ${e.title}`,
      description: e.body,
      color: SEVERITY_COLOR_HEX[e.severity],
      footer: { text: 'phoenix-terminal' },
      timestamp: new Date().toISOString(),
    };
    if (fields) embed.fields = fields;
    if (e.link) embed.url = e.link.url;
    await postJSON(this.url, { embeds: [embed] }, this.name);
  }
}

class SlackChannel implements Channel {
  name = 'slack';
  constructor(private url: string) {}
  async send(e: NotifyEvent): Promise<void> {
    const fieldsText = e.fields
      ? '\n' + Object.entries(e.fields).map(([k, v]) => `• *${k}*: ${v}`).join('\n')
      : '';
    const linkText = e.link ? `\n<${e.link.url}|${e.link.label}>` : '';
    await postJSON(this.url, {
      text: `${SEVERITY_EMOJI[e.severity]} *${e.title}*\n${e.body}${fieldsText}${linkText}`,
    }, this.name);
  }
}

class TelegramChannel implements Channel {
  name = 'telegram';
  constructor(private token: string, private chatId: string) {}
  async send(e: NotifyEvent): Promise<void> {
    const fieldsText = e.fields
      ? '\n' + Object.entries(e.fields).map(([k, v]) => `• <b>${k}</b>: ${v}`).join('\n')
      : '';
    const linkText = e.link ? `\n<a href="${e.link.url}">${e.link.label}</a>` : '';
    const url = `https://api.telegram.org/bot${this.token}/sendMessage`;
    await postJSON(url, {
      chat_id: this.chatId,
      text: `${SEVERITY_EMOJI[e.severity]} <b>${e.title}</b>\n${e.body}${fieldsText}${linkText}`,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    }, this.name);
  }
}

class GenericWebhookChannel implements Channel {
  name = 'webhook';
  constructor(private url: string) {}
  async send(e: NotifyEvent): Promise<void> {
    await postJSON(this.url, { ...e, source: 'phoenix-terminal', ts: new Date().toISOString() }, this.name);
  }
}

export class Notifier {
  private channels: Channel[] = [];
  private minSeverity: NotifySeverity;
  // Rate-limit: token bucket per channel × kind. Default 1 msg / 2s per kind,
  // 30 msg per minute aggregate per channel. A busy MM with 100 fills/min must
  // not spam Discord/Slack into a webhook ban.
  private lastSentByChannelKind = new Map<string, number>();
  private sentTimesByChannel = new Map<string, number[]>();
  private dropped = 0;
  private readonly minIntervalMs = 2_000;
  private readonly burstPerMinute = 30;

  constructor() {
    const discord = safeEnvString('DISCORD_WEBHOOK_URL', '');
    if (discord) this.channels.push(new DiscordChannel(discord));
    const slack = safeEnvString('SLACK_WEBHOOK_URL', '');
    if (slack) this.channels.push(new SlackChannel(slack));
    const tgToken = safeEnvString('TELEGRAM_BOT_TOKEN', '');
    const tgChat = safeEnvString('TELEGRAM_CHAT_ID', '');
    if (tgToken && tgChat) this.channels.push(new TelegramChannel(tgToken, tgChat));
    const generic = safeEnvString('ALERT_WEBHOOK_URL', '');
    if (generic) this.channels.push(new GenericWebhookChannel(generic));
    this.minSeverity = (safeEnvString('ALERT_MIN_SEVERITY', 'info') as NotifySeverity);
  }

  get configured(): boolean { return this.channels.length > 0; }
  get channelNames(): string[] { return this.channels.map((c) => c.name); }
  get droppedCount(): number { return this.dropped; }

  /** Returns true if the channel may send this event NOW; updates state if yes. */
  private allow(channel: string, kind: string): boolean {
    const now = Date.now();
    // Per-kind cooldown
    const key = `${channel}|${kind}`;
    const last = this.lastSentByChannelKind.get(key) ?? 0;
    if (now - last < this.minIntervalMs) return false;
    // Per-minute burst cap
    const times = this.sentTimesByChannel.get(channel) ?? [];
    const recent = times.filter((t) => now - t < 60_000);
    if (recent.length >= this.burstPerMinute) {
      this.sentTimesByChannel.set(channel, recent);
      return false;
    }
    recent.push(now);
    this.sentTimesByChannel.set(channel, recent);
    this.lastSentByChannelKind.set(key, now);
    return true;
  }

  /** Fire-and-forget. Returns immediately. */
  notify(e: NotifyEvent): void {
    if (this.channels.length === 0) return;
    if (!this.meetsSeverity(e.severity)) return;
    for (const ch of this.channels) {
      // Always pass through errors/warnings; only rate-limit info/success
      if (e.severity !== 'error' && e.severity !== 'warning' && !this.allow(ch.name, e.kind)) {
        this.dropped++;
        continue;
      }
      ch.send(e).catch((err) => getLogger().debug('notifier', `${ch.name} send: ${(err as Error).message}`));
    }
  }

  /** Awaitable version (for `notify test`). */
  async notifyAwait(e: NotifyEvent): Promise<void> {
    if (this.channels.length === 0) return;
    await Promise.allSettled(this.channels.map((ch) => ch.send(e)));
  }

  private meetsSeverity(s: NotifySeverity): boolean {
    const order: NotifySeverity[] = ['info', 'success', 'warning', 'error'];
    return order.indexOf(s) >= order.indexOf(this.minSeverity);
  }
}

let _notifier: Notifier | null = null;
export function getNotifier(): Notifier {
  if (!_notifier) _notifier = new Notifier();
  return _notifier;
}
