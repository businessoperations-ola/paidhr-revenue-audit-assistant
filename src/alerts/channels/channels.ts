import nodemailer from 'nodemailer';
import type { AppConfig } from '../../config/config.js';
import type { HubSpotSource, HubSpotTaskInput } from '../../sources/source.types.js';

export type ChannelName = 'google_chat' | 'email' | 'hubspot_task';

/** Thin senders. Each returns an external reference (message id, task id). */
export interface ChatSender {
  send(webhookUrl: string, text: string): Promise<string>;
}
export interface EmailSender {
  send(msg: { to: string[]; subject: string; text: string; html: string }): Promise<string>;
}
export interface TaskSender {
  create(task: HubSpotTaskInput): Promise<string>;
}

export interface AlertSenders {
  chat: ChatSender;
  email: EmailSender;
  task: TaskSender;
}

export const ALERT_SENDERS = Symbol('ALERT_SENDERS');

/** Google Chat incoming webhook (one per space). */
export class GoogleChatWebhookSender implements ChatSender {
  constructor(private readonly fetchFn: typeof fetch = fetch) {}

  async send(webhookUrl: string, text: string): Promise<string> {
    const res = await this.fetchFn(webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=UTF-8' },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) throw new Error(`Google Chat webhook failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
    const body = (await res.json().catch(() => ({}))) as { name?: string };
    return body.name ?? 'sent';
  }
}

/**
 * Email through Google Workspace. Use smtp.gmail.com with an app password for a
 * dedicated sender mailbox, or smtp-relay.gmail.com if the Workspace admin enables
 * the SMTP relay for the Azure egress IP.
 */
export class GmailSmtpSender implements EmailSender {
  private readonly transport: ReturnType<typeof nodemailer.createTransport>;

  constructor(private readonly cfg: AppConfig) {
    if (!cfg.MAIL_FROM) throw new Error('MAIL_FROM is required to send email alerts');
    this.transport = nodemailer.createTransport({
      host: cfg.SMTP_HOST,
      port: cfg.SMTP_PORT,
      secure: cfg.SMTP_PORT === 465,
      auth: cfg.SMTP_USER ? { user: cfg.SMTP_USER, pass: cfg.SMTP_PASSWORD } : undefined,
    });
  }

  async send(msg: { to: string[]; subject: string; text: string; html: string }): Promise<string> {
    const info = await this.transport.sendMail({ from: this.cfg.MAIL_FROM, ...msg });
    return String(info.messageId);
  }
}

export class HubSpotTaskSender implements TaskSender {
  constructor(private readonly hubspot: HubSpotSource) {}
  create(task: HubSpotTaskInput): Promise<string> {
    return this.hubspot.createTask(task);
  }
}
