import { Inject, Injectable } from '@nestjs/common';
import { Database, type Queryable } from '../db/database.js';
import type { FlagType, Finding, Severity } from '../domain/types.js';

export interface StoredFlag {
  id: number;
  type: FlagType;
  entityKey: string;
  status: 'open' | 'resolved';
  severity: Severity;
  hubspotCompanyId: string | null;
  controlPanelId: string | null;
  companyName: string;
  csmEmail: string | null;
  summary: string;
  details: Record<string, unknown>;
  aiRationale: AiRationale | null;
  firstSeenAt: string;
  acknowledgedAt: string | null;
  acknowledgedBy: string | null;
}

export interface AiRationale {
  explanation: string;
  likely_cause: string;
  recommended_action: string;
  model: string;
}

const SEVERITY_ORDER = `CASE severity WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END`;

function toFlag(r: Record<string, any>): StoredFlag {
  return {
    id: Number(r.id),
    type: r.type,
    entityKey: r.entity_key,
    status: r.status,
    severity: r.severity,
    hubspotCompanyId: r.hubspot_company_id,
    controlPanelId: r.control_panel_id,
    companyName: r.company_name,
    csmEmail: r.csm_email,
    summary: r.summary,
    details: r.details,
    aiRationale: r.ai_rationale,
    firstSeenAt: r.first_seen_at instanceof Date ? r.first_seen_at.toISOString() : r.first_seen_at,
    acknowledgedAt: r.acknowledged_at instanceof Date ? r.acknowledged_at.toISOString() : r.acknowledged_at,
    acknowledgedBy: r.acknowledged_by,
  };
}

@Injectable()
export class FlagRepository {
  constructor(@Inject(Database) private readonly db: Database) {}

  /**
   * Insert new findings and refresh existing open ones. Returns the ids of flags
   * that were newly opened by this run.
   */
  async upsertFindings(client: Queryable, runId: number, findings: Finding[]): Promise<number[]> {
    const opened: number[] = [];
    for (const f of findings) {
      const { rows } = await client.query<{ id: string; inserted: boolean }>(
        `INSERT INTO audit_flag (type, entity_key, severity, hubspot_company_id, control_panel_id, company_name,
                                 csm_email, summary, details, first_run_id, last_run_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10)
         ON CONFLICT (type, entity_key) WHERE status = 'open'
         DO UPDATE SET severity = EXCLUDED.severity, hubspot_company_id = EXCLUDED.hubspot_company_id,
                       control_panel_id = EXCLUDED.control_panel_id, company_name = EXCLUDED.company_name,
                       csm_email = EXCLUDED.csm_email, summary = EXCLUDED.summary, details = EXCLUDED.details,
                       last_run_id = EXCLUDED.last_run_id, last_seen_at = now()
         RETURNING id, (xmax = 0) AS inserted`,
        [
          f.type,
          f.entityKey,
          f.severity,
          f.hubspotCompanyId,
          f.controlPanelId,
          f.companyName,
          f.csmEmail,
          f.summary,
          JSON.stringify(f.details),
          runId,
        ],
      );
      const row = rows[0]!;
      if (row.inserted) opened.push(Number(row.id));
    }
    return opened;
  }

  /** Close open flags of the audited types that this run did not find again. */
  async resolveMissing(client: Queryable, runId: number, types: FlagType[]): Promise<number> {
    const { rowCount } = await client.query(
      `UPDATE audit_flag
          SET status = 'resolved', resolved_at = now(), resolution_reason = 'No longer detected by audit run ' || $1
        WHERE status = 'open' AND type = ANY($2) AND last_run_id <> $1`,
      [runId, types],
    );
    return rowCount ?? 0;
  }

  async findById(id: number): Promise<StoredFlag | null> {
    const { rows } = await this.db.query('SELECT * FROM audit_flag WHERE id = $1', [id]);
    return rows[0] ? toFlag(rows[0]) : null;
  }

  async list(filter: { status?: string; csmEmail?: string; type?: string; limit?: number }): Promise<StoredFlag[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.status) where.push(`status = $${params.push(filter.status)}`);
    if (filter.csmEmail) where.push(`csm_email = $${params.push(filter.csmEmail.toLowerCase())}`);
    if (filter.type) where.push(`type = $${params.push(filter.type)}`);
    const limit = Math.min(Math.max(filter.limit ?? 200, 1), 1000);
    const { rows } = await this.db.query(
      `SELECT * FROM audit_flag ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY ${SEVERITY_ORDER}, first_seen_at DESC LIMIT ${limit}`,
      params,
    );
    return rows.map(toFlag);
  }

  /**
   * Open flags with at least one enabled channel not yet delivered: no alert on
   * that channel was sent or skipped, and retries are not exhausted.
   */
  async listUndelivered(channels: string[], maxAttempts: number): Promise<StoredFlag[]> {
    const { rows } = await this.db.query(
      `SELECT f.* FROM audit_flag f
        WHERE f.status = 'open'
          AND EXISTS (
            SELECT 1 FROM unnest($1::text[]) AS ch(name)
             WHERE NOT EXISTS (
               SELECT 1 FROM alert a
                WHERE a.flag_id = f.id AND a.channel = ch.name
                  AND (a.status IN ('sent', 'skipped') OR a.attempts >= $2)
             )
          )
        ORDER BY ${SEVERITY_ORDER}, f.id`,
      [channels, maxAttempts],
    );
    return rows.map(toFlag);
  }

  async setRationale(id: number, rationale: AiRationale): Promise<void> {
    await this.db.query('UPDATE audit_flag SET ai_rationale = $2 WHERE id = $1', [id, JSON.stringify(rationale)]);
  }

  /** Returns false if the flag does not exist or was already acknowledged. */
  async acknowledge(id: number, by: string): Promise<boolean> {
    const { rowCount } = await this.db.query(
      `UPDATE audit_flag SET acknowledged_at = now(), acknowledged_by = $2
        WHERE id = $1 AND acknowledged_at IS NULL`,
      [id, by],
    );
    return (rowCount ?? 0) > 0;
  }
}
