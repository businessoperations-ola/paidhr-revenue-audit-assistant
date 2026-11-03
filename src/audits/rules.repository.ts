import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { BusinessCalendar } from '../common/calendar.js';
import { Database } from '../db/database.js';

const RulesSchema = z.object({
  arr_tolerance_kobo: z.coerce.number().int().min(0),
  payroll_grace_business_days: z.coerce.number().int().min(0).max(30),
  mandatory_fields: z.array(z.string()),
  seat_history_days: z.coerce.number().int().min(2).max(800),
});

export type AuditRules = z.infer<typeof RulesSchema>;
export const RULE_KEYS = Object.keys(RulesSchema.shape) as Array<keyof AuditRules>;

@Injectable()
export class RulesRepository {
  constructor(@Inject(Database) private readonly db: Database) {}

  async load(): Promise<AuditRules> {
    const { rows } = await this.db.query<{ key: string; value: unknown }>('SELECT key, value FROM rules_config');
    return RulesSchema.parse(Object.fromEntries(rows.map((r) => [r.key, r.value])));
  }

  async listWithMeta() {
    const { rows } = await this.db.query(
      'SELECT key, value, description, updated_at, updated_by FROM rules_config ORDER BY key',
    );
    return rows;
  }

  /** Validates the value against the rule's type before saving. */
  async update(key: string, value: unknown, actor: string): Promise<void> {
    if (!RULE_KEYS.includes(key as keyof AuditRules)) throw new Error(`Unknown rule: ${key}`);
    const shape = RulesSchema.shape[key as keyof AuditRules];
    const parsed = shape.parse(value);
    await this.db.transaction(async (client) => {
      await client.query(
        'UPDATE rules_config SET value = $2, updated_at = now(), updated_by = $3 WHERE key = $1',
        [key, JSON.stringify(parsed), actor],
      );
      await client.query(
        `INSERT INTO action_log (actor, action, object_type, object_id, details) VALUES ($1, 'rule.update', 'rules_config', $2, $3)`,
        [actor, key, JSON.stringify({ value: parsed })],
      );
    });
  }

  async calendar(): Promise<BusinessCalendar> {
    const { rows } = await this.db.query<{ d: string }>('SELECT holiday_date AS d FROM public_holiday');
    return new BusinessCalendar(rows.map((r) => r.d));
  }
}
