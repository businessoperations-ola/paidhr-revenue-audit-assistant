import { Inject, Injectable } from '@nestjs/common';
import { Database } from '../db/database.js';
import { CatalogError } from './catalog.service.js';
import { DEFAULT_SCORING, mergeScoring, SCORING_FIELDS, validateScoring, type ScoringConfig } from './scoring-config.js';
import { describeScoring } from './scoring-notes.js';
import { CRITERION_KINDS, DEFAULT_USAGE_RULES, FALLBACK_USAGE_RULE, validateUsageRule, WINDOWS, type UsageRule } from './usage.js';

/** What counts as "in use" for each module, and the weights behind adoption, churn and upsell. Admin-editable. */
@Injectable()
export class AdoptionSettingsService {
  constructor(@Inject(Database) private readonly db: Database) {}

  async scoring(): Promise<ScoringConfig> {
    const { rows } = await this.db.query(`SELECT value FROM adoption_setting WHERE key = 'scoring'`);
    return mergeScoring(rows[0]?.value);
  }

  async usageRules(): Promise<Map<string, UsageRule>> {
    const { rows } = await this.db.query(`SELECT module, mode, criteria FROM module_usage_rule`);
    return new Map(rows.map((r) => [r.module as string, { mode: r.mode, criteria: r.criteria } as UsageRule]));
  }

  async overview() {
    const [scoring, saved, mods, meta] = await Promise.all([
      this.scoring(),
      this.usageRules(),
      this.db.query<{ key: string; label: string; active: boolean }>('SELECT key, label, active FROM product_module ORDER BY sort_order, key'),
      this.db.query(`SELECT updated_by, updated_at FROM adoption_setting WHERE key = 'scoring'`),
    ]);
    return {
      scoring,
      defaults: DEFAULT_SCORING,
      scoringChangedBy: meta.rows[0]?.updated_by ?? null,
      fields: SCORING_FIELDS,
      notes: describeScoring(scoring),
      usage: mods.rows.map((m) => ({ module: m.key, label: m.label, active: m.active, rule: saved.get(m.key) ?? DEFAULT_USAGE_RULES[m.key] ?? FALLBACK_USAGE_RULE, isDefault: !saved.has(m.key) })),
      criteriaKinds: CRITERION_KINDS,
      windows: WINDOWS,
    };
  }

  async saveScoring(input: unknown, actor: string): Promise<ScoringConfig> {
    // Only what is sent changes: it is laid over what is saved now, then the whole is checked.
    const v = validateScoring(input, await this.scoring());
    if (!v.ok) throw new CatalogError(v.errors.join('. '));
    await this.db.query(
      `INSERT INTO adoption_setting (key, value, updated_by) VALUES ('scoring', $1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [JSON.stringify(v.config), actor],
    );
    await this.audit(actor, 'scoring.save', 'scoring', {});
    return v.config;
  }

  async resetScoring(actor: string): Promise<ScoringConfig> {
    await this.db.query(`DELETE FROM adoption_setting WHERE key = 'scoring'`);
    await this.audit(actor, 'scoring.reset', 'scoring', {});
    return DEFAULT_SCORING;
  }

  async saveUsageRule(module: string, input: unknown, actor: string): Promise<UsageRule> {
    const v = validateUsageRule(input);
    if (!v.ok) throw new CatalogError(v.errors.join('. '));
    if ((await this.db.query('SELECT 1 FROM product_module WHERE key = $1', [module])).rowCount === 0) throw new CatalogError('Module not found', 404);
    await this.db.query(
      `INSERT INTO module_usage_rule (module, mode, criteria, updated_by) VALUES ($1, $2, $3, $4)
       ON CONFLICT (module) DO UPDATE SET mode = EXCLUDED.mode, criteria = EXCLUDED.criteria, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [module, v.rule.mode, JSON.stringify(v.rule.criteria), actor],
    );
    await this.audit(actor, 'usage.save', module, { mode: v.rule.mode, criteria: v.rule.criteria.length });
    return v.rule;
  }

  async resetUsageRule(module: string, actor: string): Promise<UsageRule> {
    await this.db.query('DELETE FROM module_usage_rule WHERE module = $1', [module]);
    await this.audit(actor, 'usage.reset', module, {});
    return DEFAULT_USAGE_RULES[module] ?? FALLBACK_USAGE_RULE;
  }

  private audit(actor: string, action: string, object: string, details: object) {
    return this.db.query(`INSERT INTO action_log (actor, action, object_type, object_id, details) VALUES ($1, $2, 'adoption', $3, $4)`, [actor, action, object, JSON.stringify(details)]);
  }
}
