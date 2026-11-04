import { BadRequestException, Body, Controller, ConflictException, ForbiddenException, Get, HttpCode, Inject, NotFoundException, Param, Post, Put, Req } from '@nestjs/common';
import { z } from 'zod';
import { Roles, type AuthUser, type Role } from '../auth/auth.js';
import { APP_CONFIG, type AppConfig } from '../config/config.js';
import { Database } from '../db/database.js';
import { OrgService } from '../org/org.service.js';

type Req = { user: AuthUser };

export const ROLE_LIST = ['super_admin', 'cs_director', 'cs_team_lead', 'csm', 'implementation_manager', 'support_specialist', 'viewer'] as const;
const InviteBody = z.object({ email: z.string().trim().email().max(200), role: z.enum(ROLE_LIST), name: z.string().trim().max(120).optional() });
const UpdateBody = z.object({ role: z.enum(ROLE_LIST).optional(), active: z.boolean().optional(), name: z.string().trim().max(120).optional(), managerEmail: z.string().trim().email().nullable().optional() }).refine((b) => Object.keys(b).length > 0, 'Nothing to change');

/** Roles that count as administrators in the web app. */
export const ADMIN_ROLES: Role[] = ['super_admin', 'cs_director'];

/** Who can use the portal. Directors manage everyone except super admins; only super admins touch super admins. */
@Controller('users')
export class UsersController {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    @Inject(OrgService) private readonly org: OrgService,
  ) {}

  @Get()
  @Roles('cs_director')
  async list() {
    const { rows } = await this.db.query(
      `SELECT email, role, active, display_name AS name, manager_email AS "managerEmail", invited_by AS "invitedBy", created_at AS "createdAt", last_seen_at AS "lastSeenAt"
         FROM app_user ORDER BY active DESC, role, email`,
    );
    return rows;
  }

  @Post()
  @Roles('cs_director')
  async invite(@Req() req: Req, @Body() body: unknown) {
    const parsed = InviteBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues.map((i) => i.message).join('; '));
    const email = parsed.data.email.toLowerCase();
    const domain = this.cfg.GOOGLE_WORKSPACE_DOMAIN;
    if (domain && !email.endsWith(`@${domain.toLowerCase()}`)) throw new BadRequestException(`Only @${domain} accounts can be added. Sign-in is through Google Workspace.`);
    this.checkMayAssign(req.user, parsed.data.role);
    const { rowCount } = await this.db.query(
      `INSERT INTO app_user (email, role, display_name, invited_by) VALUES ($1, $2, $3, $4) ON CONFLICT (email) DO NOTHING`,
      [email, parsed.data.role, parsed.data.name ?? null, req.user.email],
    );
    if (!rowCount) throw new ConflictException(`${email} already has access. Change their role instead.`);
    await this.audit(req.user, 'user.invite', email, { role: parsed.data.role });
    return { email, role: parsed.data.role, active: true };
  }

  @Put(':email')
  @Roles('cs_director')
  async update(@Req() req: Req, @Param('email') emailParam: string, @Body() body: unknown) {
    const parsed = UpdateBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues.map((i) => i.message).join('; '));
    const email = emailParam.toLowerCase();
    const { rows } = await this.db.query<{ role: Role; active: boolean }>('SELECT role, active FROM app_user WHERE email = $1', [email]);
    const current = rows[0];
    if (!current) throw new NotFoundException('User not found');
    const { role, active, name } = parsed.data;
    const managerEmail = parsed.data.managerEmail === undefined ? undefined : (parsed.data.managerEmail?.toLowerCase() ?? null);
    if (current.role === 'super_admin') this.checkMayAssign(req.user, 'super_admin');
    if (role) this.checkMayAssign(req.user, role);
    if (email === req.user.email && ((role && role !== current.role) || active === false)) throw new ForbiddenException('You cannot change your own role or deactivate yourself.');
    const nextRole = role ?? current.role;
    const nextActive = active ?? current.active;
    if (current.role === 'super_admin' && current.active && (nextRole !== 'super_admin' || !nextActive)) {
      const n = (await this.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM app_user WHERE role = 'super_admin' AND active`)).rows[0]!.n;
      if (n <= 1) throw new ConflictException('There must be at least one active super admin.');
    }
    if (managerEmail) {
      const m = (await this.db.query<{ role: Role }>('SELECT role FROM app_user WHERE email = $1 AND active', [managerEmail])).rows[0];
      if (!m) throw new BadRequestException('The person they report to must be an active user');
      if (!['super_admin', 'cs_director', 'cs_team_lead'].includes(m.role)) throw new BadRequestException('People can only report to a Team Lead, a CS Director or a super admin');
      if (await this.org.wouldLoop(email, managerEmail)) throw new ConflictException('That would make a reporting loop');
    }
    await this.db.query(
      `UPDATE app_user SET role = $2, active = $3, display_name = COALESCE($4, display_name), manager_email = CASE WHEN $6::boolean THEN $5 ELSE manager_email END WHERE email = $1`,
      [email, nextRole, nextActive, name ?? null, managerEmail ?? null, managerEmail !== undefined],
    );
    await this.audit(req.user, active !== undefined && active !== current.active ? (active ? 'user.restore' : 'user.deactivate') : 'user.update', email, { role: nextRole, active: nextActive, ...(managerEmail !== undefined ? { managerEmail } : {}) });
    return { email, role: nextRole, active: nextActive };
  }

  /** Only a super admin may create or change a super admin. */
  private checkMayAssign(actor: AuthUser, role: Role): void {
    if (role === 'super_admin' && actor.role !== 'super_admin') throw new ForbiddenException('Only a super admin can grant or change the super admin role.');
  }

  private audit(actor: AuthUser, action: string, target: string, details: object) {
    return this.db.query(`INSERT INTO action_log (actor, action, object_type, object_id, details) VALUES ($1, $2, 'app_user', $3, $4)`, [actor.email, action, target, JSON.stringify(details)]);
  }
}
