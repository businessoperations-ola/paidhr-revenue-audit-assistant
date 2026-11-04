import Anthropic, { betaRefusalFallbackMiddleware } from '@anthropic-ai/sdk';
import { AnthropicFoundry } from '@anthropic-ai/foundry-sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { Logger } from '@nestjs/common';
import type { z } from 'zod';
import type { AppConfig } from '../config/config.js';

/** The one method of the SDK this app uses, so tests can supply a fake. */
export interface ClaudeClientLike {
  beta: { messages: { parse(params: Record<string, unknown>): Promise<ClaudeParsed> } };
}

interface ClaudeParsed {
  stop_reason?: string | null;
  parsed_output?: unknown;
  model: string;
  usage?: { input_tokens?: number; output_tokens?: number };
}

export interface ClaudeResult<T> {
  value: T;
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
}

export interface GenerateOptions<T> {
  /** Short name for logs, e.g. "onboarding_playbook". */
  kind: string;
  schema: z.ZodType<T>;
  system: string;
  user: string;
  /** Thinking depth and cost. Routine writing tasks use "low". */
  effort?: 'low' | 'medium' | 'high';
  maxTokens?: number;
}

/** What every feature calls. Returns null, never throws, so a Claude problem cannot break a daily job. */
export interface ClaudeGenerator {
  generate<T>(opts: GenerateOptions<T>): Promise<ClaudeResult<T> | null>;
}

type ClaudeConfig = Pick<AppConfig, 'CLAUDE_PROVIDER' | 'CLAUDE_MODEL'>;

/**
 * Calls Claude with a Zod schema for the answer. Uses Microsoft Foundry by default (billing stays
 * in Azure) or the Anthropic API directly. The client is created on first use, so no credentials
 * are needed while every AI feature is switched off.
 */
export class ClaudeService implements ClaudeGenerator {
  private readonly log = new Logger('ClaudeService');
  private client: ClaudeClientLike | null = null;

  constructor(
    private readonly cfg: ClaudeConfig,
    private readonly clientFactory?: () => ClaudeClientLike,
  ) {}

  private getClient(): ClaudeClientLike {
    if (!this.client) {
      this.client =
        this.clientFactory?.() ??
        // Credentials come from the environment: ANTHROPIC_FOUNDRY_RESOURCE + ANTHROPIC_FOUNDRY_API_KEY, or
        // ANTHROPIC_API_KEY. Foundry has no server-side refusal fallback, so the SDK middleware does it there.
        ((this.cfg.CLAUDE_PROVIDER === 'foundry'
          ? new AnthropicFoundry({ middleware: [betaRefusalFallbackMiddleware([{ model: 'claude-opus-4-8' }])] })
          : new Anthropic()) as unknown as ClaudeClientLike);
    }
    return this.client;
  }

  async generate<T>(opts: GenerateOptions<T>): Promise<ClaudeResult<T> | null> {
    try {
      const response = await this.getClient().beta.messages.parse({
        model: this.cfg.CLAUDE_MODEL,
        max_tokens: opts.maxTokens ?? 8000,
        system: opts.system,
        messages: [{ role: 'user', content: opts.user }],
        output_config: { effort: opts.effort ?? 'low', format: betaZodOutputFormat(opts.schema) },
        ...(this.cfg.CLAUDE_PROVIDER === 'anthropic' ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' } : {}),
      });
      if (response.stop_reason === 'refusal' || response.parsed_output === null || response.parsed_output === undefined) {
        this.log.warn(`${opts.kind}: no usable answer (stop_reason=${response.stop_reason ?? 'none'})`);
        return null;
      }
      return {
        value: response.parsed_output as T,
        model: response.model,
        inputTokens: response.usage?.input_tokens ?? null,
        outputTokens: response.usage?.output_tokens ?? null,
      };
    } catch (err) {
      this.log.warn(`${opts.kind} failed: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }
}

export const CLAUDE_GENERATOR = Symbol('CLAUDE_GENERATOR');
