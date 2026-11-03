import { NestFactory } from '@nestjs/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WorkerModule } from '../../src/app.module.js';
import { Database } from '../../src/db/database.js';
import { JobRunner } from '../../src/jobs/job-runner.js';
import { resetDatabase, testConfig } from './harness.js';

/** Boots the real module graph with no test overrides, the way the scheduled job does. */
describe('worker boot without overrides', () => {
  let app: Awaited<ReturnType<typeof NestFactory.createApplicationContext>>;

  beforeAll(async () => {
    await resetDatabase();
    // No Claude, email or chat credentials: AI is off and alerts are a dry run.
    app = await NestFactory.createApplicationContext(
      WorkerModule.forRoot(testConfig({ ALERTS_DRY_RUN: 'true', MAIL_FROM: '', GOOGLE_CHAT_DEFAULT_WEBHOOK: '' })),
      { logger: false },
    );
    await app.get(Database).migrate();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('runs the daily job end to end on fixture data', async () => {
    const result = (await app.get(JobRunner).run('daily', '2026-11-03')) as any;
    expect(result.audit.findings).toBe(8);
    expect(result.dispatch).toMatchObject({ flagsConsidered: 8, dryRun: true, sent: 0 });
  });
});
