import Anthropic, { betaRefusalFallbackMiddleware } from '@anthropic-ai/sdk';
import { AnthropicFoundry } from '@anthropic-ai/foundry-sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';
import type { AiRationale, StoredFlag } from '../audits/flag.repository.js';
import { APP_CONFIG, type AppConfig } from '../config/config.js';
import type { FlagType } from '../domain/types.js';

/** Flag types worth a written explanation. Missing-field and unlinked flags explain themselves. */
export const RATIONALE_TYPES: ReadonlySet<FlagType> = new Set([
  'ARR_MISMATCH',
  'SEAT_INCREASE_NO_ARR_CHANGE',
  'RENEWAL_NO_ARR_CHANGE',
  'SEAT_OVERAGE',
  'BROKEN_LINK',
  'LATE_PAYROLL',
]);

const RationaleSchema = z.object({
  explanation: z.string().describe('Two sentences at most: what the numbers show, in plain English.'),
  likely_cause: z.string().describe('The most likely operational cause, one sentence.'),
  recommended_action: z.string().describe('The single next step the CSM should take, one sentence, imperative.'),
});

const SYSTEM_PROMPT = `You help Customer Success Managers at a Nigerian HR and payroll software company act on automated billing and operations audit flags.

You receive one flag: its type, a one-line summary, and the evidence the audit computed. The numbers are already correct; never recompute or contradict them. Amounts are Nigerian Naira (₦); fields ending in _kobo are kobo (₦1 = 100 kobo).

Write for a busy CSM reading a chat message: short, specific, no hedging, no greetings. Name the concrete next step, such as updating the deal ARR in HubSpot, confirming seat counts with the client's HR admin, or calling the client about a missed payroll run. If the evidence is not enough to infer a cause, say what to check.`;

/** Anything that can turn a flag into a rationale. Tests replace this. */
export interface RationaleGenerator {
  generate(flag: StoredFlag): Promise<AiRationale | null>;
}

export const RATIONALE_GENERATOR = Symbol('RATIONALE_GENERATOR');

/**
 * Claude-backed rationale writer. Uses Microsoft Foundry by default (billing stays
 * in Azure) or the Anthropic API directly. Failures never block an alert: the
 * caller sends the alert without a rationale.
 */
@Injectable()
export class ClaudeRationaleGenerator implements RationaleGenerator {
  private readonly log = new Logger(ClaudeRationaleGenerator.name);
  // Foundry has no Batches API, so its type differs; only beta.messages is used here.
  private readonly client: Anthropic | AnthropicFoundry;
  private readonly provider: AppConfig['CLAUDE_PROVIDER'];
  private readonly model: string;

  constructor(@Inject(APP_CONFIG) cfg: AppConfig) {
    this.provider = cfg.CLAUDE_PROVIDER;
    this.model = cfg.CLAUDE_MODEL;
    // Credentials come from the environment: ANTHROPIC_FOUNDRY_RESOURCE + ANTHROPIC_FOUNDRY_API_KEY,
    // or ANTHROPIC_API_KEY. Foundry has no server-side refusal fallback, so the SDK middleware does it.
    this.client =
      cfg.CLAUDE_PROVIDER === 'foundry'
        ? new AnthropicFoundry({ middleware: [betaRefusalFallbackMiddleware([{ model: 'claude-opus-4-8' }])] })
        : new Anthropic();
  }

  async generate(flag: StoredFlag): Promise<AiRationale | null> {
    const evidence = {
      type: flag.type,
      severity: flag.severity,
      company: flag.companyName,
      summary: flag.summary,
      evidence: flag.details,
    };
    try {
      const response = await this.client.beta.messages.parse({
        model: this.model,
        max_tokens: 2000,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: JSON.stringify(evidence, null, 2) }],
        // A short, well-specified writing task: low effort keeps it fast and cheap.
        output_config: { effort: 'low', format: betaZodOutputFormat(RationaleSchema) },
        ...(this.provider === 'anthropic'
          ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const }
          : {}),
      });
      if (response.stop_reason === 'refusal' || !response.parsed_output) {
        this.log.warn(`No rationale for flag ${flag.id}: stop_reason=${response.stop_reason}`);
        return null;
      }
      return { ...response.parsed_output, model: response.model };
    } catch (err) {
      this.log.warn(`Rationale failed for flag ${flag.id}: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }
}
