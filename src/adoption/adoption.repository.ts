import { Inject, Injectable } from '@nestjs/common';
import { Database } from '../db/database.js';
import type { AdminAction, ClientAdmin, ClientModule, EmployeeActivity } from '../domain/types.js';

/** Stores the adoption data pulled from the Control Panel. Each call replaces the whole set. */
@Injectable()
export class AdoptionRepository {
  constructor(@Inject(Database) private readonly db: Database) {}

  async replaceAdmins(admins: ClientAdmin[], actions: AdminAction[]): Promise<void> {
    await this.db.transaction(async (c) => {
      await c.query('DELETE FROM cp_client_admin');
      await c.query('DELETE FROM cp_admin_action');
      if (admins.length > 0) {
        await c.query(
          `INSERT INTO cp_client_admin (client_id, email, name, level, last_login_at)
           SELECT DISTINCT ON (client_id, email) * FROM jsonb_to_recordset($1::jsonb) AS x(client_id text, email text, name text, level text, last_login_at timestamptz)`,
          [JSON.stringify(admins.map((a) => ({ client_id: a.clientId, email: a.email, name: a.name, level: a.level, last_login_at: a.lastLoginAt })))],
        );
      }
      if (actions.length > 0) {
        await c.query(
          `INSERT INTO cp_admin_action (client_id, email, action_at, action)
           SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(client_id text, email text, action_at timestamptz, action text)`,
          [JSON.stringify(actions.map((a) => ({ client_id: a.clientId, email: a.email, action_at: a.at, action: a.action })))],
        );
      }
    });
  }

  async replaceEmployeeActivity(rows: EmployeeActivity[]): Promise<void> {
    await this.db.transaction(async (c) => {
      await c.query('DELETE FROM cp_employee_activity');
      for (let i = 0; i < rows.length; i += 5000) {
        await c.query(
          `INSERT INTO cp_employee_activity (activity_date, client_id, module, event_type, events, active_employees)
           SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(activity_date date, client_id text, module text, event_type text, events integer, active_employees integer)`,
          [JSON.stringify(rows.slice(i, i + 5000).map((r) => ({ activity_date: r.date, client_id: r.clientId, module: r.module, event_type: r.eventType, events: r.events, active_employees: r.activeEmployees })))],
        );
      }
    });
  }

  async replaceModules(modules: ClientModule[]): Promise<void> {
    await this.db.transaction(async (c) => {
      await c.query('DELETE FROM cp_client_module');
      if (modules.length > 0) {
        await c.query(
          `INSERT INTO cp_client_module (client_id, module, purchased_on, configured_on, configured_known)
           SELECT DISTINCT ON (client_id, module) * FROM jsonb_to_recordset($1::jsonb) AS x(client_id text, module text, purchased_on date, configured_on date, configured_known boolean)`,
          [JSON.stringify(modules.map((m) => ({ client_id: m.clientId, module: m.module, purchased_on: m.purchasedOn, configured_on: m.configuredOn ?? null, configured_known: m.configuredOn !== undefined })))],
        );
      }
    });
  }
}
