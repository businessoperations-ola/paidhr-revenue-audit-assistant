import { Module, type DynamicModule, type Provider } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ClaudeService, CLAUDE_GENERATOR } from './ai/claude.service.js';
import { AI_FEATURES, ClaudeAiFeatures, DisabledAiFeatures } from './ai/features.js';
import { ClaudeRationaleGenerator, RATIONALE_GENERATOR } from './ai/rationale.service.js';
import { AnalyticsService } from './analytics/analytics.service.js';
import { BroadcastService } from './broadcasts/broadcast.service.js';
import { CxService } from './cx/cx.service.js';
import { ReportBuilder } from './reports/report-builder.js';
import { ReportService } from './reports/report.service.js';
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
import { OrgService } from './org/org.service.js';
import { PortfolioService } from './portfolio/portfolio.service.js';
import { UsersController } from './api/users.controller.js';
import { MeController, TeamController, WebAppController } from './api/admin.controllers.js';
import { AnalyticsController, BroadcastController, CxController, PortfolioController, ReportScheduleController } from './api/phase34.controllers.js';
import { BigIntInterceptor, DomainErrorFilter } from './api/http.js';
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
    AnalyticsService,
    CxService,
    OrgService,
    PortfolioService,
    ReportBuilder,
    ReportService,
    BroadcastService,
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
    // One Claude client for every AI feature. It connects on first use, so no credentials are needed
    // while all of them are switched off.
    { provide: CLAUDE_GENERATOR, useFactory: () => new ClaudeService(cfg) },
    {
      provide: RATIONALE_GENERATOR,
      inject: [CLAUDE_GENERATOR],
      useFactory: (claude: ClaudeService) => (cfg.AI_RATIONALE_ENABLED ? new ClaudeRationaleGenerator(claude) : { generate: async () => null }),
    },
    {
      provide: AI_FEATURES,
      inject: [CLAUDE_GENERATOR],
      useFactory: (claude: ClaudeService) => (cfg.AI_FEATURES_ENABLED ? new ClaudeAiFeatures(claude) : new DisabledAiFeatures()),
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
        UsersController,
        FlagsController,
        ReportsController,
        RulesController,
        TeamController,
        JobsController,
        AnalyticsController,
        ReportScheduleController,
        CxController,
        PortfolioController,
        BroadcastController,
      ],
      providers: [
        ...coreProviders(cfg),
        { provide: IDENTITY_VERIFIER, useFactory: () => new GoogleIdentityVerifier(cfg) },
        { provide: APP_GUARD, useClass: AuthGuard },
        { provide: APP_INTERCEPTOR, useClass: BigIntInterceptor },
        { provide: APP_FILTER, useClass: DomainErrorFilter },
      ],
    };
  }
}
