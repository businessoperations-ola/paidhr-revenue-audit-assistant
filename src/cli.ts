import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './app.module.js';
import { todayInLagos } from './common/calendar.js';
import { loadConfig } from './config/config.js';
import { Database } from './db/database.js';
import { JOB_NAMES, JobRunner, type JobName } from './jobs/job-runner.js';

const USAGE = `Usage: node dist/cli.js <migrate|${JOB_NAMES.join('|')}> [--date YYYY-MM-DD]

  migrate   apply database migrations
  ingest    snapshot HubSpot + Control Panel for the date (default: today in WAT)
  audit     run phase-1 audits on that snapshot
  dispatch  send undelivered alerts (also retries failures)
  escalate  send unacknowledged alerts to team leads, then directors (US-16)
  reports   send the daily/weekly/monthly reports that are due (US-25)
  broadcasts  send admin broadcasts that are due, and resume interrupted ones (US-22)
  baseline  lock each CSM's ARR for the year (run on 1 January, US-18)
  cx-weekly cluster the last 30 days of tickets into themes with draft macros (US-28)
  team      set a CSM's team lead: team <csm-email> <lead-email>
  daily     ingest, audit, dispatch (the 04:00 WAT scheduled job)
  grant     grant API access: grant <email> <role>`;

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const dateIdx = rest.indexOf('--date');
  const date = dateIdx >= 0 ? rest[dateIdx + 1] : todayInLagos();
  if (!command || !date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    console.error(USAGE);
    process.exit(2);
  }

  const cfg = loadConfig();
  const app = await NestFactory.createApplicationContext(WorkerModule.forRoot(cfg), { logger: ['log', 'warn', 'error'] });
  try {
    const db = app.get(Database);
    if (command === 'migrate') {
      const ran = await db.migrate();
      console.log(ran.length ? `Applied: ${ran.join(', ')}` : 'Database is up to date');
      return;
    }
    await db.migrate();
    if (command === 'grant') {
      const [email, role] = rest;
      if (!email || !role) throw new Error('grant <email> <role>');
      await db.query(
        `INSERT INTO app_user (email, role) VALUES (lower($1), $2) ON CONFLICT (email) DO UPDATE SET role = EXCLUDED.role`,
        [email, role],
      );
      await db.query(
        `INSERT INTO action_log (actor, action, object_type, object_id, details) VALUES ('cli', 'user.grant', 'app_user', lower($1), $2)`,
        [email, JSON.stringify({ role })],
      );
      console.log(`${email} → ${role}`);
      return;
    }
    if (command === 'team') {
      const [csm, lead] = rest;
      if (!csm || !lead) throw new Error('team <csm-email> <lead-email>');
      await db.query(
        `INSERT INTO csm_team (csm_email, team_lead_email, updated_by) VALUES (lower($1), lower($2), 'cli')
         ON CONFLICT (csm_email) DO UPDATE SET team_lead_email = EXCLUDED.team_lead_email, updated_at = now(), updated_by = 'cli'`,
        [csm, lead],
      );
      console.log(`${csm} → team lead ${lead}`);
      return;
    }
    if (!JOB_NAMES.includes(command as JobName)) {
      console.error(USAGE);
      process.exitCode = 2;
      return;
    }
    const result = await app.get(JobRunner).run(command as JobName, date);
    console.log(JSON.stringify(result, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
  } finally {
    await app.close();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack : err);
  process.exit(1);
});
