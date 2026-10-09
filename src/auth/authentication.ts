import {
  type CallHandler, type CanActivate, type ExecutionContext, Inject, Injectable, type NestInterceptor, UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { type Kysely, sql, type Transaction } from 'kysely';
import { from, lastValueFrom, type Observable } from 'rxjs';
import { CONFIG, type Config } from '../config/config';
import { digestsEqual, sha256 } from '../common/crypto';
import { IS_PUBLIC } from '../common/http';
import type { Database } from '../database/schema';
import { DB, TenantContext, withTenant } from '../database/tenant';
import type { Principal } from '../policy/policy';
import { API_KEY_FORMAT, verifyAccessToken } from './tokens';

/** Who the credentials name; what they may do is loaded later, inside the tenant transaction. */
export type Credential = { kind: 'user'; id: string; orgId: string } | { kind: 'integration'; id: string; orgId: string };

export interface AuthenticatedRequest extends Request {
  credential?: Credential;
}

const INVALID = 'Missing or invalid credentials';
const LAST_USED_PRECISION_MS = 60_000;

/**
 * Global guard: checks the credential cryptographically (JWT signature, or API key secret against
 * its stored hash). Exactly one kind of credential is accepted per request, each only in its own
 * header, so a key can't be replayed as a token or the other way round.
 */
@Injectable()
export class AuthenticationGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(CONFIG) private readonly config: Config,
    @Inject(DB) private readonly db: Kysely<Database>,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [context.getHandler(), context.getClass()])) return true;
    const req = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const { authorization } = req.headers;
    const apiKey = req.headers['x-api-key'];
    if (authorization !== undefined && apiKey !== undefined) throw new UnauthorizedException('Send either a bearer token or an API key, not both');
    const credential = apiKey !== undefined ? await this.fromApiKey(apiKey) : this.fromBearer(authorization);
    if (!credential) throw new UnauthorizedException(INVALID);
    req.credential = credential;
    return true;
  }

  private fromBearer(header: string | undefined): Credential | null {
    const token = /^Bearer (\S+)$/.exec(header ?? '')?.[1];
    const claims = token ? verifyAccessToken(this.config.JWT_SECRET, token) : null;
    return claims ? { kind: 'user', id: claims.userId, orgId: claims.orgId } : null;
  }

  /**
   * The key's secret is 256 random bits, so a fast hash (SHA-256) is the right tool: slow,
   * salted hashes exist to protect low-entropy passwords from guessing, which doesn't apply.
   */
  private async fromApiKey(header: string | string[]): Promise<Credential | null> {
    const match = typeof header === 'string' ? API_KEY_FORMAT.exec(header) : null;
    if (!match) return null;
    const [, prefix, secret] = match as unknown as [string, string, string];
    const { rows } = await sql<{ id: string; org_id: string; secret_hash: string }>`
      select * from auth_api_key_lookup(${prefix})`.execute(this.db);
    const key = rows[0];
    return key && digestsEqual(key.secret_hash, sha256(secret)) ? { kind: 'integration', id: key.id, orgId: key.org_id } : null;
  }
}

/**
 * Wraps each authenticated request in one transaction scoped to the caller's organization, loads
 * the principal (current role, department, scopes) inside it, and exposes both through
 * TenantContext. If the handler throws, everything it wrote, audit events included, rolls back.
 */
@Injectable()
export class TenantInterceptor implements NestInterceptor {
  constructor(@Inject(DB) private readonly db: Kysely<Database>, private readonly tenant: TenantContext) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const { credential } = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (!credential) return next.handle();
    return from(withTenant(this.db, credential.orgId, async (trx) => {
      const principal = await loadPrincipal(trx, credential);
      if (!principal) throw new UnauthorizedException(INVALID);
      return this.tenant.run({ trx, principal }, () => lastValueFrom(next.handle() as Observable<unknown>, { defaultValue: undefined }));
    }));
  }
}

export async function loadPrincipal(trx: Transaction<Database>, credential: Credential): Promise<Principal | null> {
  if (credential.kind === 'user') {
    // Row-level security already limits this to the token's organization.
    const user = await trx.selectFrom('users').select(['id', 'org_id', 'role', 'department_id', 'clearance'])
      .where('id', '=', credential.id).where('disabled_at', 'is', null).executeTakeFirst();
    return user ? {
      kind: 'user', id: user.id, orgId: user.org_id, role: user.role, departmentId: user.department_id, clearance: user.clearance,
    } : null;
  }
  const key = await trx.selectFrom('api_keys').select(['id', 'org_id', 'department_id', 'scopes', 'last_used_at'])
    .where('id', '=', credential.id).where('revoked_at', 'is', null)
    .where((eb) => eb.or([eb('expires_at', 'is', null), eb('expires_at', '>', new Date())]))
    .executeTakeFirst();
  // "Last used" is for spotting forgotten keys, so a minute's precision is plenty: reads stay reads.
  if (key && (key.last_used_at === null || Date.now() - key.last_used_at.getTime() > LAST_USED_PRECISION_MS)) {
    await trx.updateTable('api_keys').set({ last_used_at: new Date() }).where('id', '=', key.id).execute();
  }
  return key ? { kind: 'integration', id: key.id, orgId: key.org_id, departmentId: key.department_id, scopes: key.scopes } : null;
}
