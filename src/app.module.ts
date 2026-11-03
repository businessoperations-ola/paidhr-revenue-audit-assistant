import { Module, type DynamicModule, type Provider } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ClaudeRationaleGenerator, RATIONALE_GENERATOR } from './ai/rationale.service.js';
import { AlertDispatcher } from './alerts/alert-dispatcher.service.js';
import { EscalationService } from './alerts/escalation.service.js';
import {
  ALERT_SENDERS,
  GmailSmtpSender,
  GoogleChatWebhookSender,
  HubSpotTaskSender,
  type AlertSenders,
} from './alerts/channels/channels.js';
import {
  AckController,
  FlagsController,
  HealthController,
  JobsController,
  ReportsController,
  RulesController,
} from './api/controllers.js';
import { MeController, TeamController, WebAppController } from './api/admin.controllers.js';
import { AuditService } from './audits/audit.service.js';
import { FlagRepository } from './audits/flag.repository.js';
import { RulesRepository } from './audits/rules.repository.js';
import { AuthGuard, GoogleIdentityVerifier, IDENTITY_VERIFIER } from './auth/auth.js';
import { APP_CONFIG, type AppConfig } from './config/config.js';
import { Database } from './db/database.js';
import { IngestionService } from './ingestion/ingestion.service.js';
import { SnapshotRepository } from './ingestion/snapshot.repository.js';
import { JobRunner } from './jobs/job-runner.js';
import { ControlPanelRepository } from './sources/control-panel/control-panel.repository.js';
import { FixtureControlPanelSource, FixtureHubSpotSource } from './sources/fixtures/fixture.sources.js';
import { HubSpotClient } from './sources/hubspot/hubspot.client.js';
import { CONTROL_PANEL_SOURCE, HUBSPOT_SOURCE, type HubSpotSource } from './sources/source.types.js';

/** Sends nothing: used when email isn't configured, so the chat and task channels still work. */
const unconfiguredEmail = {
  send: async () => {
    throw new Error('Email is not configured (set MAIL_FROM and SMTP_* settings)');
  },
};

export function coreProviders(cfg: AppConfig): Provider[] {
  return [
    { provide: APP_CONFIG, useValue: cfg },
    Database,
    SnapshotRepository,
    FlagRepository,
    RulesRepository,
    IngestionService,
    AuditService,
    AlertDispatcher,
    EscalationService,
    JobRunner,
    {
      provide: HUBSPOT_SOURCE,
      useFactory: () => (cfg.SOURCE_MODE === 'fixtures' ? new FixtureHubSpotSource() : new HubSpotClient(cfg)),
    },
    {
      provide: CONTROL_PANEL_SOURCE,
      useFactory: () =>
        cfg.SOURCE_MODE === 'fixtures' ? new FixtureControlPanelSource() : new ControlPanelRepository(cfg),
    },
    {
      provide: ALERT_SENDERS,
      inject: [HUBSPOT_SOURCE],
      useFactory: (hubspot: HubSpotSource): AlertSenders => ({
        chat: new GoogleChatWebhookSender(),
        email: cfg.MAIL_FROM ? new GmailSmtpSender(cfg) : unconfiguredEmail,
        task: new HubSpotTaskSender(hubspot),
      }),
    },
    {
      // Only build the Claude client when it will be used, so no credentials are needed otherwise.
      provide: RATIONALE_GENERATOR,
      useFactory: () => (cfg.AI_RATIONALE_ENABLED ? new ClaudeRationaleGenerator(cfg) : { generate: async () => null }),
    },
  ];
}

/** Jobs only: no HTTP layer. */
@Module({})
export class WorkerModule {
  static forRoot(cfg: AppConfig): DynamicModule {
    const providers = coreProviders(cfg);
    return { module: WorkerModule, providers, exports: providers as never[] };
  }
}

/** The API: everything in the worker plus controllers and the Google sign-in guard. */
@Module({})
export class ApiModule {
  static forRoot(cfg: AppConfig): DynamicModule {
    return {
      module: ApiModule,
      controllers: [
        WebAppController,
        HealthController,
        AckController,
        MeController,
        FlagsController,
        ReportsController,
        RulesController,
        TeamController,
        JobsController,
      ],
      providers: [
        ...coreProviders(cfg),
        { provide: IDENTITY_VERIFIER, useFactory: () => new GoogleIdentityVerifier(cfg) },
        { provide: APP_GUARD, useClass: AuthGuard },
      ],
    };
  }
}
