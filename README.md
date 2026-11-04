# Revenue & Data Audit Assistant

Every morning at 04:00 WAT this service snapshots HubSpot and the Control Panel, checks billing and payroll, and alerts the right CSM in Google Chat, Gmail and HubSpot before the CX team starts work.

Phases 1 and 2 cover the billing audits, late-payroll alerts, engagement checks and escalation:

| Story | What it checks | Flag type | Severity |
| --- | --- | --- | --- |
| US-01 | Deal ARR = seats × price per seat per month × 12, to the kobo (tolerance ₦0.01) | `ARR_MISMATCH` | high |
| US-02 | Seats grew, or the contract renewed, but ARR has not changed since | `SEAT_INCREASE_NO_ARR_CHANGE`, `RENEWAL_NO_ARR_CHANGE` | high / medium |
| US-03 | Active HubSpot customers vs active Control Panel accounts | `UNLINKED_HUBSPOT_COMPANY`, `UNLINKED_CONTROL_PANEL_ACCOUNT`, `BROKEN_LINK` | medium / high |
| US-04 | Sub-account count and total users per parent account | report (`GET /reports/latest`) | – |
| US-05 | Users across the parent and all sub-accounts > HubSpot paid seats | `SEAT_OVERAGE` | high |
| US-15 | Every new flag goes to the CSM; a HubSpot task is created per flag | – | – |
| US-17 | Empty mandatory HubSpot fields, listed per company | `MISSING_FIELDS` | low |
| US-24 | Payroll not run within the grace buffer (default 2 business days) after its expected date | `LATE_PAYROLL` | urgent |
| US-13 / 14 | No call, meeting or email logged within the limit for the customer's health status (At Risk 7 days, Neutral 14, Healthy 30) | `ENGAGEMENT_DROUGHT` | high / medium / low |
| US-16 | Urgent and high alerts not acknowledged within 3 business days go to the CSM's team lead, then 2 business days later to every CS Director | escalation | – |

## How it works

```
Container Apps Job (04:00 WAT)
  └─ node dist/cli.js daily
       1. ingest    HubSpot companies + Control Panel accounts → daily snapshot tables
       2. audit     run every rule on today's snapshot → audit_flag (one open flag per problem)
       3. dispatch  new flags → Google Chat, Gmail, HubSpot tasks (recorded in `alert`)
Container Apps Job (08:00 WAT, Mon–Fri)
  └─ node dist/cli.js escalate   unacknowledged urgent/high alerts → team lead → CS Directors
API (Container App, Google sign-in)
  └─ admin web app at /, plus flags, acknowledgements, reports, rules, team leads, manual job runs
```

- **The numbers are computed in code, never by AI.** Every audit is a pure function in `src/audits/`, unit-tested. Money is integer kobo (`bigint`), so the ₦0.01 check is exact.
- **One open flag per problem.** If a problem is found again it updates the same flag. When the next audit no longer finds it, the flag closes automatically. A late payroll gets a new flag for each missed pay date.
- **Alerts are sent once.** Urgent flags go out on their own. Everything else is grouped into one chat message and one email per CSM per run. Failed sends are retried by the hourly `dispatch` job, up to 3 attempts per channel.
- **Acknowledge links are signed.** The link in Chat or email opens a confirmation page. Only pressing the button records the acknowledgement, because email security scanners open links automatically.
- **Safety stops.** The audit refuses to run without today's snapshot, and refuses an empty HubSpot pull. An outage therefore can't raise false late-payroll alerts or close every open flag.
- **Escalation counts working days.** The clock starts when the CSM was first alerted. Acknowledging stops it, except for engagement droughts: those count as handled only when a call, meeting or email is logged in HubSpot, which also closes the flag. A CSM with no team lead on record escalates straight to the directors.
- **Claude is optional.** With `AI_RATIONALE_ENABLED=true`, Claude Opus 5.5 (via Microsoft Foundry) adds a short "why" and "next step" to billing and payroll alerts. A failure never blocks an alert.
- **Phase 3: numbers for leadership.** ARR bridge (new, expansion, contraction, churn), renewals, module adoption, contractor seats, health mix, ticket volume and each CSM's ARR against their 1 January baseline. All computed in code from daily snapshots. Contracts that expire after the last snapshot and have not renewed are left out of the renewal rate rather than counted as lost. Reports (Leadership, CSM, Implementation, Support) are scheduled in the app under Reports and sent by the `reports` job at 08:00 Lagos time.
- **Phase 4: Claude CX tools (off by default).** With `AI_FEATURES_ENABLED=true`: onboarding playbooks on stalled accounts, ticket themes with draft macros and KB outlines, QBR drafts, and tone scoring that feeds a support early warning. Ticket text is redacted before storage and before it reaches Claude, and every answer is checked in code (real ticket ids only, size limits). Without it, the expansion radar, the 90-day scorecard and the reopened-ticket warning still work.
- **Admin broadcasts.** Super admins and CS Directors can write to CSMs, the CX team and (super admins only) clients, now or on a schedule. Safe by default: `BROADCASTS_LIVE=false` is a dry run, the send must confirm the previewed count, there is a recipient cap, text is a safe subset (no HTML), clients get email only, and each client email is logged as a HubSpot note.

## Run it locally

You need Node 22 and PostgreSQL 16.

```bash
npm install
cp .env.example .env            # demo mode: SOURCE_MODE=fixtures, ALERTS_DRY_RUN=true, AUTH_DISABLED=true
createdb audit_dev
set -a; . ./.env; set +a
npm run build
node dist/cli.js daily --date 2026-11-03   # fixture data contains one example of every flag
node dist/main.js                          # API on :8080, e.g. curl localhost:8080/flags
```

Tests (unit tests, plus integration tests against a real Postgres):

```bash
createdb audit_test && createdb control_panel_test
TEST_DATABASE_URL=postgresql://…/audit_test TEST_CP_DATABASE_URL=postgresql://…/control_panel_test npm test
```

## CLI

| Command | What it does |
| --- | --- |
| `node dist/cli.js migrate` | Apply database migrations (also runs automatically on start). |
| `node dist/cli.js daily [--date YYYY-MM-DD]` | Ingest, audit, then dispatch. This is the scheduled job. |
| `node dist/cli.js ingest\|audit\|dispatch [--date …]` | Run one step on its own. |
| `node dist/cli.js escalate [--date …]` | Send unacknowledged alerts to team leads and directors (the 08:00 WAT job). |
| `node dist/cli.js grant <email> <role>` | Give a Google Workspace user access to the API and web app. |
| `node dist/cli.js team <csm-email> <lead-email>` | Set a CSM's team lead (also editable in the web app). |

Roles: `super_admin`, `cs_director`, `cs_team_lead`, `csm`, `implementation_manager`, `support_specialist`, `viewer`.

## Admin web app

Open the API's address in a browser and sign in with your company Google account. It has four screens:

- **Alerts:** every flag, most severe first, filterable by status, type and "escalated only". Select one to see where it was sent and acknowledge it. CSMs only see their own accounts.
- **Rules:** inactivity limits per health status, escalation timing and which alert levels escalate, plus the phase 1 thresholds. Super admins can edit; everyone else can read. Every change is logged with who made it.
- **Team leads:** which team lead each CSM escalates to. Directors can edit.
- **Reconciliation:** the latest HubSpot vs Control Panel counts and the sub-account tree.

The app and the HTML alert emails use the PaidHR brand: brand blue `#004AF5`, navy `#012B86`, yellow `#FDC023` and midnight `#0B1A3C`, sampled from paidhr.com. Type is Gilroy where it's installed, otherwise Plus Jakarta Sans. While alerts are in dry-run mode, a navy strip across the top says so. Set `HELP_EMAIL` to show a "Get help" link on the sign-in screen.

The logo files in `src/web/brand/` were cut from screenshots of paidhr.com. To use the official artwork, replace `paidhr-logo-blue.png` (for light backgrounds) and `paidhr-logo-white.png` (for blue backgrounds), then run `python3 scripts/embed-brand.py`. Emails load the white logo from `<APP_BASE_URL>/brand/paidhr-logo-white.png`.

The app is served by the API itself, so it needs no separate hosting. Add the API's address as an authorised JavaScript origin on the Google OAuth client.

## API

Every route needs `Authorization: Bearer <Google ID token>` for a user granted access with `grant`, except `/health` and the signed `/ack` links. The ID token must come from your Workspace domain.

| Route | Who | |
| --- | --- | --- |
| `GET /` | anyone | The admin web app (sign-in happens in the browser) |
| `GET /me` | any signed-in user | Who you are and your role |
| `GET /flags?status=open\|resolved\|all&type=&csm=&escalated=true` | CSM (own accounts only), lead, director, viewer | Flags, most severe first |
| `GET /flags/:id` | same | Flag with its delivery history |
| `POST /flags/:id/acknowledge` | CSM, lead, director | |
| `GET /reports/latest` | lead, director, viewer | US-03 reconciliation counts + US-04 sub-account counts |
| `GET /rules`, `PUT /rules/:key` | read: managers; write: super admin | Thresholds, validated and logged |
| `GET /team`, `PUT /team/:csm`, `DELETE /team/:csm` | read: managers; write: director | Team lead per CSM, logged |
| `POST /jobs/:name?date=` | super admin | Run `ingest`, `audit`, `dispatch`, `escalate` or `daily` now |
| `GET/POST /ack/:id?sig=` | anyone holding the signed link | One-click acknowledge from an alert |

Rules admins can change without a deploy: `arr_tolerance_kobo` (1), `payroll_grace_business_days` (2), `mandatory_fields`, `seat_history_days` (400), `inactivity_days_by_health` (At Risk 7, Neutral 14, Healthy 30, default 14), `escalation_business_days` (3), `director_escalation_business_days` (2) and `escalate_severities` (urgent, high). Public holidays live in the `public_holiday` table. Fixed-date holidays and Easter for 2026–2027 are seeded. **Add the Eid holidays (and any Monday holiday declared when a holiday falls on a weekend) once the government announces them.**

## Connecting the real systems

### HubSpot

1. Create a **private app** that can read companies and owners and create tasks. Put its token in Key Vault as `hubspot-token`.
2. Make sure each customer company has these properties. The internal names are configurable with `HS_PROP_*`:
   `control_panel_id`, `csm_email` (or set the company owner), `csm_name`, `industry`, `contract_end_date`, `seat_tier`, `paid_seats`, `arr_ngn`, `price_per_seat_monthly_ngn`, `health_status` (values `At Risk`, `Neutral`, `Healthy`).
   Engagement uses HubSpot's built-in **Last contacted** (`notes_last_contacted`), set when a call, meeting or email is logged. Change it with `HS_PROP_LAST_ACTIVITY` if your team tracks contact differently.
3. Only companies with lifecycle stage `customer` are audited (`HS_CUSTOMER_LIFECYCLE_STAGE`).

### Control Panel

The Control Panel team installs `docs/control-panel-views.sql` on the read replica, replacing the placeholder table names with the real ones. That file is the contract. The integration tests install it as shipped, so keep the column names. Connect with the read-only `audit_reader` role. The service also forces every session to read-only.

### Google Workspace

- **Sign-in:** create an OAuth client (type "Web application") in Google Cloud for the admin web app. Set `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_WORKSPACE_DOMAIN`. Personal Gmail accounts are rejected.
- **Google Chat:** in the CX alerts space, open *Apps & integrations → Webhooks*, add a webhook, and store its URL in Key Vault as `google-chat-webhook`.
- **Gmail:** use a dedicated sender mailbox (for example `audit-assistant@…`) with an app password (`smtp-user`, `smtp-password`). Alternatively, have the Workspace admin enable the SMTP relay for the Azure outbound IP and set `SMTP_HOST=smtp-relay.gmail.com`.

## Deploying to Azure

`infra/main.bicep` creates a private VNet, PostgreSQL Flexible Server (no public access), Key Vault, a container registry, a Container Apps environment, the API (which also serves the admin web app), and three scheduled jobs: `daily` at 03:00 UTC (04:00 WAT), `dispatch` hourly 08:15–18:15 WAT on weekdays, and `escalate` at 07:00 UTC (08:00 WAT) on weekdays.

> The Bicep template has not been compiled in this environment. The `infra` job in `.github/workflows/ci.yml` runs `az bicep build` on every push. Fix anything it reports before the first deploy.

1. Create a resource group in South Africa North and a bootstrap Key Vault holding `postgres-admin-password`.
2. Deploy: `az deployment group create -g <rg> -f infra/main.bicep -p @infra/main.parameters.json` (copy it from `main.parameters.example.json`).
3. In the Key Vault the template created, add the secrets: `database-url` (`postgresql://…/audit?sslmode=require`), `control-panel-database-url`, `hubspot-token`, `smtp-user`, `smtp-password`, `google-chat-webhook`, `ack-link-secret` (32+ random characters) and `foundry-api-key`. Use a placeholder for any channel you are not using yet.
4. Build and push the image: `az acr build -r <acr> -t audit-assistant:<sha> .`, then redeploy with `imageTag=<sha>`.
5. Grant yourself access: run the `daily` job's image once with `node dist/cli.js grant you@paidhr.com super_admin`.

## Go-live checklist

- [ ] Finance confirms the US-01 formula, and which seat count it uses (`ARR_SEAT_SOURCE`).
- [ ] Every active customer has a Control Panel ID in HubSpot. The first `UNLINKED_*` report shows which ones are missing.
- [ ] Control Panel view installed and checked against 5 known accounts.
- [ ] One week in shadow mode (`alertsLive=false`). Review the flags with CX Ops, then tune the rules.
- [ ] Grant every CS Director the `cs_director` role, and set each CSM's team lead (web app → Team leads).
- [ ] Check HubSpot health statuses are exactly `At Risk`, `Neutral` or `Healthy` (other values use the default limit).
- [ ] Turn on alerts per channel (`alertsLive=true`). Optionally turn on `aiRationaleEnabled`.

## Not built yet

Phase 3: scheduled role-based reports and digests (US-25), churn, renewal, adoption and ARR analytics (US-06–12, 18, 19). Phase 4: Claude-powered CX tools (US-26–28) and admin broadcasts (US-20–23).
