import { Inject, Injectable, type OnApplicationShutdown } from '@nestjs/common';
import pg from 'pg';
import { APP_CONFIG, type AppConfig } from '../config/config.js';
import { migration001 } from './migrations/001_init.js';

// Return bigint columns as strings (we convert to BigInt explicitly) and dates as 'YYYY-MM-DD'.
pg.types.setTypeParser(pg.types.builtins.DATE, (v: string) => v);

export type Queryable = Pick<pg.PoolClient, 'query'>;

const MIGRATIONS: Array<{ version: string; sql: string }> = [{ version: '001_init', sql: migration001 }];

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
