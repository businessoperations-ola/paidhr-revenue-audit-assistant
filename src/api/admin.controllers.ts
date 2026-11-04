import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Put,
  Req,
  StreamableFile,
} from '@nestjs/common';
import { z } from 'zod';
import { Public, Roles, type AuthUser } from '../auth/auth.js';
import { APP_CONFIG, type AppConfig } from '../config/config.js';
import { Database } from '../db/database.js';
import { ADMIN_APP_HTML } from '../web/admin-app.js';
import { LOGO_BLUE_PNG, LOGO_WHITE_PNG } from '../web/brand/logos.js';

type Req = { user: AuthUser };

/** The signed-in user, so the web app can show the right screens. */
@Controller('me')
export class MeController {
  @Get()
  me(@Req() req: Req) {
    return { ...req.user, isAdmin: req.user.role === 'super_admin' || req.user.role === 'cs_director' };
  }
}

const TeamBody = z.object({ teamLeadEmail: z.string().email() });

/** US-16: who each CSM escalates to. */
@Controller('team')
export class TeamController {
  constructor(@Inject(Database) private readonly db: Database) {}

  @Get()
  @Roles('cs_director', 'cs_team_lead', 'viewer')
  async list() {
    const { rows } = await this.db.query(
      `SELECT csm_email AS "csmEmail", team_lead_email AS "teamLeadEmail", updated_at AS "updatedAt", updated_by AS "updatedBy"
         FROM csm_team ORDER BY csm_email`,
    );
    return rows;
  }

  @Put(':csm')
  @Roles('cs_director')
  async set(@Req() req: Req, @Param('csm') csm: string, @Body() body: unknown) {
    const parsed = TeamBody.safeParse(body);
    if (!parsed.success || !z.string().email().safeParse(csm).success) {
      throw new BadRequestException('Use PUT /team/<csm email> with { "teamLeadEmail": "<email>" }');
    }
    const csmEmail = csm.toLowerCase();
    const lead = parsed.data.teamLeadEmail.toLowerCase();
    await this.db.transaction(async (client) => {
      await client.query(
        `INSERT INTO csm_team (csm_email, team_lead_email, updated_by) VALUES ($1, $2, $3)
         ON CONFLICT (csm_email) DO UPDATE SET team_lead_email = EXCLUDED.team_lead_email, updated_at = now(), updated_by = EXCLUDED.updated_by`,
        [csmEmail, lead, req.user.email],
      );
      await client.query(
        `INSERT INTO action_log (actor, action, object_type, object_id, details) VALUES ($1, 'team.set', 'csm_team', $2, $3)`,
        [req.user.email, csmEmail, JSON.stringify({ teamLeadEmail: lead })],
      );
    });
    return { csmEmail, teamLeadEmail: lead };
  }

  @Delete(':csm')
  @HttpCode(200)
  @Roles('cs_director')
  async remove(@Req() req: Req, @Param('csm') csm: string) {
    const { rowCount } = await this.db.query('DELETE FROM csm_team WHERE csm_email = $1', [csm.toLowerCase()]);
    if (!rowCount) throw new NotFoundException();
    await this.db.query(
      `INSERT INTO action_log (actor, action, object_type, object_id) VALUES ($1, 'team.remove', 'csm_team', $2)`,
      [req.user.email, csm.toLowerCase()],
    );
    return { removed: true };
  }
}

/**
 * The admin web app: one page served by the API itself, so it shares its origin
 * and needs no separate hosting. Google sign-in happens in the browser.
 */
@Controller()
export class WebAppController {
  constructor(@Inject(APP_CONFIG) private readonly cfg: AppConfig) {}

  @Public()
  @Get()
  @Header('content-type', 'text/html; charset=utf-8')
  @Header(
    'content-security-policy',
    [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' https://accounts.google.com/gsi/client",
      "style-src 'self' 'unsafe-inline' https://accounts.google.com/gsi/style https://fonts.googleapis.com",
      "font-src https://fonts.gstatic.com",
      "frame-src https://accounts.google.com/gsi/",
      "connect-src 'self' https://accounts.google.com/gsi/",
      "img-src 'self' data: https://*.googleusercontent.com",
    ].join('; '),
  )
  app() {
    return ADMIN_APP_HTML;
  }

  /** Logo files, so alert emails can show the PaidHR logo. */
  @Public()
  @Get('brand/paidhr-logo-blue.png')
  @Header('content-type', 'image/png')
  @Header('cache-control', 'public, max-age=86400')
  logoBlue() {
    return new StreamableFile(LOGO_BLUE_PNG);
  }

  @Public()
  @Get('brand/paidhr-logo-white.png')
  @Header('content-type', 'image/png')
  @Header('cache-control', 'public, max-age=86400')
  logoWhite() {
    return new StreamableFile(LOGO_WHITE_PNG);
  }

  @Public()
  @Get('app-config')
  config() {
    return {
      googleClientId: this.cfg.GOOGLE_OAUTH_CLIENT_ID ?? null,
      authDisabled: this.cfg.AUTH_DISABLED,
      alertsDryRun: this.cfg.ALERTS_DRY_RUN,
      helpEmail: this.cfg.HELP_EMAIL ?? null,
    };
  }
}
