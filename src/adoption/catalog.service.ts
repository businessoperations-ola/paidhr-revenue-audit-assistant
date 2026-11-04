import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { Database } from '../db/database.js';
import type { CatalogModule, SeasonWindow, Signal } from './intelligence.js';

export class CatalogError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409 = 400) {
    super(message);
  }
}

const Month = z.number().int().min(1).max(12);
const Window = z.object({ startMonth: Month, endMonth: Month, boost: z.number().int().min(0).max(30), reason: z.string().trim().min(1).max(120) });
const ModulePatch = z.object({
  label: z.string().trim().min(1).max(60).optional(),
  launchedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  launchNote: z.string().trim().max(160).nullable().optional(),
  active: z.boolean().optional(),
});
const NewModule = z.object({ key: z.string().regex(/^[A-Z][A-Z0-9_]{1,29}$/, 'Use capital letters, digits and underscores, e.g. BENEFITS'), label: z.string().trim().min(1).max(60) });
const NewSignal = z.object({
  hubspotId: z.string().min(1).max(40),
  kind: z.enum(['FUNDRAISE', 'EXPANSION', 'HIRING_PLAN', 'OTHER']),
  detail: z.string().trim().min(3).max(300),
  happenedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  validUntil: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

export interface StoredSignal extends Signal {
  id: number;
  hubspotId: string;
  validUntil: string;
  addedBy: string;
  createdAt: string;
}

/** The module catalogue, the seasonal buying windows, and the growth signals CSMs record. */
@Injectable()
export class AdoptionCatalogService {
  constructor(@Inject(Database) private readonly db: Database) {}

  async modules(): Promise<CatalogModule[]> {
    const { rows } = await this.db.query(`SELECT key, label, launched_on, launch_note, active FROM product_module ORDER BY sort_order, key`);
    return rows.map((r) => ({ key: r.key, label: r.label, launchedOn: r.launched_on, launchNote: r.launch_note, active: r.active }));
  }

  async windows(): Promise<SeasonWindow[]> {
    const { rows } = await this.db.query(`SELECT module, start_month, end_month, boost, reason FROM module_seasonality ORDER BY module, start_month`);
    return rows.map((r) => ({ module: r.module, startMonth: r.start_month, endMonth: r.end_month, boost: r.boost, reason: r.reason }));
  }

  /** Whether anyone has changed the seasonal windows since they were seeded. */
  async windowsConfirmed(): Promise<boolean> {
    return (await this.db.query(`SELECT 1 FROM module_seasonality WHERE updated_by IS NOT NULL LIMIT 1`)).rowCount === 1;
  }

  async updateModule(key: string, raw: unknown, actor: string): Promise<CatalogModule> {
    const p = ModulePatch.safeParse(raw);
    if (!p.success || Object.keys(p.data).length === 0) throw new CatalogError(p.success ? 'Nothing to change' : p.error.issues.map((i) => i.message).join('; '));
    const cur = (await this.modules()).find((m) => m.key === key);
    if (!cur) throw new CatalogError('Module not found', 404);
    const next = { ...cur, ...Object.fromEntries(Object.entries(p.data).filter(([, v]) => v !== undefined)) } as CatalogModule;
    await this.db.query(
      `UPDATE product_module SET label = $2, launched_on = $3, launch_note = $4, active = $5, updated_by = $6, updated_at = now() WHERE key = $1`,
      [key, next.label, next.launchedOn, next.launchNote, next.active, actor],
    );
    await this.audit(actor, 'module.update', key, p.data);
    return next;
  }

  async addModule(raw: unknown, actor: string): Promise<CatalogModule> {
    const p = NewModule.safeParse(raw);
    if (!p.success) throw new CatalogError(p.error.issues.map((i) => i.message).join('; '));
    const { rowCount } = await this.db.query(
      `INSERT INTO product_module (key, label, sort_order, updated_by) VALUES ($1, $2, (SELECT COALESCE(max(sort_order), 0) + 10 FROM product_module), $3) ON CONFLICT (key) DO NOTHING`,
      [p.data.key, p.data.label, actor],
    );
    if (!rowCount) throw new CatalogError(`${p.data.key} already exists`, 409);
    await this.audit(actor, 'module.add', p.data.key, { label: p.data.label });
    return { key: p.data.key, label: p.data.label, launchedOn: null, launchNote: null, active: true };
  }

  /** Replaces all the buying windows of one module. */
  async setWindows(module: string, raw: unknown, actor: string): Promise<SeasonWindow[]> {
    const p = z.array(Window).max(6).safeParse(raw);
    if (!p.success) throw new CatalogError(p.error.issues.map((i) => i.message).join('; '));
    if (!(await this.modules()).some((m) => m.key === module)) throw new CatalogError('Module not found', 404);
    await this.db.transaction(async (c) => {
      await c.query('DELETE FROM module_seasonality WHERE module = $1', [module]);
      for (const w of p.data) await c.query(`INSERT INTO module_seasonality (module, start_month, end_month, boost, reason, updated_by) VALUES ($1, $2, $3, $4, $5, $6)`, [module, w.startMonth, w.endMonth, w.boost, w.reason, actor]);
      // Mark the rest as reviewed too, so the "defaults" note goes away once someone has been through them.
      await c.query(`UPDATE module_seasonality SET updated_by = COALESCE(updated_by, $1) WHERE updated_by IS NULL`, [actor]);
    });
    await this.audit(actor, 'season.set', module, { windows: p.data.length });
    return p.data.map((w) => ({ module, ...w }));
  }

  // ------------------------------------------------------------------ growth signals

  async signals(companyIds?: string[]): Promise<StoredSignal[]> {
    const { rows } = await this.db.query(
      `SELECT id, hubspot_company_id, kind, detail, happened_on, valid_until, added_by, created_at FROM account_signal
        WHERE valid_until >= current_date ${companyIds ? 'AND hubspot_company_id = ANY($1)' : ''} ORDER BY happened_on DESC, id DESC`,
      companyIds ? [companyIds] : [],
    );
    return rows.map((r) => ({ id: Number(r.id), hubspotId: r.hubspot_company_id, kind: r.kind, detail: r.detail, happenedOn: r.happened_on, validUntil: r.valid_until, addedBy: r.added_by, createdAt: new Date(r.created_at).toISOString() }));
  }

  async addSignal(raw: unknown, actor: string, today: string): Promise<StoredSignal> {
    const p = NewSignal.safeParse(raw);
    if (!p.success) throw new CatalogError(p.error.issues.map((i) => i.message).join('; '));
    const d = p.data;
    if (Number.isNaN(Date.parse(d.happenedOn))) throw new CatalogError('Pick a real date');
    const validUntil = d.validUntil ?? new Date(Date.parse(`${d.happenedOn}T00:00:00Z`) + 180 * 86_400_000).toISOString().slice(0, 10);
    if (validUntil < today) throw new CatalogError('That signal has already expired');
    const detail = d.detail.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    const { rows } = await this.db.query(
      `INSERT INTO account_signal (hubspot_company_id, kind, detail, happened_on, valid_until, added_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, created_at`,
      [d.hubspotId, d.kind, detail, d.happenedOn, validUntil, actor],
    );
    await this.audit(actor, 'signal.add', d.hubspotId, { kind: d.kind });
    return { id: Number(rows[0]!.id), hubspotId: d.hubspotId, kind: d.kind, detail, happenedOn: d.happenedOn, validUntil, addedBy: actor, createdAt: new Date(rows[0]!.created_at).toISOString() };
  }

  async findSignal(id: number): Promise<{ hubspotId: string; addedBy: string } | null> {
    const { rows } = await this.db.query('SELECT hubspot_company_id, added_by FROM account_signal WHERE id = $1', [id]);
    return rows[0] ? { hubspotId: rows[0].hubspot_company_id, addedBy: rows[0].added_by } : null;
  }

  async removeSignal(id: number, actor: string): Promise<void> {
    await this.db.query('DELETE FROM account_signal WHERE id = $1', [id]);
    await this.audit(actor, 'signal.remove', String(id), {});
  }

  private audit(actor: string, action: string, object: string, details: object) {
    return this.db.query(`INSERT INTO action_log (actor, action, object_type, object_id, details) VALUES ($1, $2, 'adoption', $3, $4)`, [actor, action, object, JSON.stringify(details)]);
  }
}
