import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { OAuth2Client } from 'google-auth-library';
import { APP_CONFIG, type AppConfig } from '../config/config.js';
import { Database } from '../db/database.js';

export type Role =
  | 'super_admin'
  | 'cs_director'
  | 'cs_team_lead'
  | 'csm'
  | 'implementation_manager'
  | 'support_specialist'
  | 'viewer';

export interface AuthUser {
  email: string;
  role: Role;
}

export const ROLES_KEY = 'roles';
export const PUBLIC_KEY = 'public';
/** Roles allowed on a route. Super admins are always allowed. */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);
export const Public = () => SetMetadata(PUBLIC_KEY, true);

/** Verifies a Google ID token and returns the signed-in Workspace email. */
export interface IdentityVerifier {
  verify(token: string): Promise<string>;
}
export const IDENTITY_VERIFIER = Symbol('IDENTITY_VERIFIER');

export class GoogleIdentityVerifier implements IdentityVerifier {
  private readonly client = new OAuth2Client();

  constructor(private readonly cfg: AppConfig) {}

  async verify(token: string): Promise<string> {
    if (!this.cfg.GOOGLE_OAUTH_CLIENT_ID || !this.cfg.GOOGLE_WORKSPACE_DOMAIN) {
      throw new UnauthorizedException('Google sign-in is not configured');
    }
    const ticket = await this.client.verifyIdToken({ idToken: token, audience: this.cfg.GOOGLE_OAUTH_CLIENT_ID });
    const p = ticket.getPayload();
    if (!p?.email || !p.email_verified) throw new UnauthorizedException('Email not verified');
    // `hd` is only present for Workspace accounts, so personal Gmail accounts are rejected too.
    if (p.hd !== this.cfg.GOOGLE_WORKSPACE_DOMAIN) throw new UnauthorizedException('Not a company Google account');
    return p.email.toLowerCase();
  }
}

/**
 * Global guard: every route needs a Google ID token (Authorization: Bearer …)
 * for a user listed in `app_user`, unless marked @Public().
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    @Inject(Database) private readonly db: Database,
    @Inject(IDENTITY_VERIFIER) private readonly verifier: IdentityVerifier,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, targets)) return true;

    const req = ctx.switchToHttp().getRequest();
    let user: AuthUser;
    if (this.cfg.AUTH_DISABLED) {
      user = { email: 'dev@localhost', role: 'super_admin' };
    } else {
      const header: string | undefined = req.headers.authorization;
      if (!header?.startsWith('Bearer ')) throw new UnauthorizedException('Missing Google ID token');
      let email: string;
      try {
        email = await this.verifier.verify(header.slice(7));
      } catch (err) {
        if (err instanceof UnauthorizedException) throw err;
        throw new UnauthorizedException('Invalid Google ID token');
      }
      const { rows } = await this.db.query<{ role: Role; active: boolean }>('SELECT role, active FROM app_user WHERE email = $1', [email]);
      if (!rows[0]) throw new ForbiddenException(`${email} has no access to the Audit Assistant`);
      if (!rows[0].active) throw new ForbiddenException(`${email} has been deactivated. Ask an admin to restore access.`);
      // Record sign-ins at most once an hour, so this is not a write on every request.
      await this.db.query(`UPDATE app_user SET last_seen_at = now() WHERE email = $1 AND (last_seen_at IS NULL OR last_seen_at < now() - interval '1 hour')`, [email]);
      user = { email, role: rows[0].role };
    }
    req.user = user;

    const allowed = this.reflector.getAllAndOverride<Role[] | undefined>(ROLES_KEY, targets);
    if (allowed && user.role !== 'super_admin' && !allowed.includes(user.role)) {
      throw new ForbiddenException('Your role cannot use this endpoint');
    }
    return true;
  }
}
