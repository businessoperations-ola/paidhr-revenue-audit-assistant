import { Inject, Injectable, type OnApplicationShutdown } from '@nestjs/common';
import pg from 'pg';
import { APP_CONFIG, type AppConfig } from '../config/config.js';
import { migration001 } from './migrations/001_init.js';
import { migration002 } from './migrations/002_engagement_escalation.js';
import { migration003 } from './migrations/003_analytics_cx_broadcasts.js';
import { migration004 } from './migrations/004_user_management.js';
import { migration005 } from './migrations/005_org_chart.js';
import { migration006 } from './migrations/006_adoption.js';
import { migration007 } from './migrations/007_head_of_cx.js';

// Return bigint columns as strings (we convert to BigInt explicitly) and dates as 'YYYY-MM-DD'.
pg.types.setTypeParser(pg.types.builtins.DATE, (v: string) => v);

export type Queryable = Pick<pg.PoolClient, 'query'>;

const MIGRATIONS: Array<{ version: string; sql: string }> = [
  { version: '001_init', sql: migration001 },
  { version: '002_engagement_escalation', sql: migration002 },
  { version: '003_analytics_cx_broadcasts', sql: migration003 },
  { version: '004_user_management', sql: migration004 },
  { version: '005_org_chart', sql: migration005 },
  { version: '006_adoption', sql: migration006 },
  { version: '007_head_of_cx', sql: migration007 },
];

@Injectable()
export class Database implements OnApplicationShutdown {
  readonly pool: pg.Pool;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.pool = new pg.Pool({ connectionString: config.DATABASE_URL, max: 10 });
  }

  query<R extends pg.QueryResultRow = pg.QueryResultRow>(text: string, params: unknown[] = []) {
    return this.pool.query<R>(text, params);
  }

  async transaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /** Apply pending migrations under an advisory lock, so parallel starts are safe. */
  async migrate(): Promise<string[]> {
    return this.transaction(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(424242)');
      await client.query(
        'CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
      );
      const { rows } = await client.query<{ version: string }>('SELECT version FROM schema_migrations');
      const applied = new Set(rows.map((r) => r.version));
      const ran: string[] = [];
      for (const m of MIGRATIONS) {
        if (applied.has(m.version)) continue;
        await client.query(m.sql);
        await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [m.version]);
        ran.push(m.version);
      }
      return ran;
    });
  }

  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}
