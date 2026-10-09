import {
  type CallHandler, type CanActivate, type ExecutionContext, ForbiddenException, Inject, Injectable, InternalServerErrorException, Logger,
  type NestInterceptor, UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { type Kysely, sql, type Transaction } from 'kysely';
import { from, lastValueFrom, type Observable } from 'rxjs';
import { actorOf, AuditService } from '../audit/audit.service';
import { CONFIG, type Config } from '../config/config';
import { digestsEqual, sha256 } from '../common/crypto';
import { ANY_PRINCIPAL, IS_PUBLIC, REQUIRES } from '../common/http';
import type { Database } from '../database/schema';
import { DB, TenantContext, withTenant } from '../database/tenant';
import type { Action, Principal } from '../policy/policy';
import { API_KEY_FORMAT, verifyAccessToken } from './tokens';

/** Who the credentials name; what they may do is loaded later, inside the tenant transaction. */
export type Credential = { kind: 'user'; id: string; orgId: string } | { kind: 'integration'; id: string; orgId: string };

export interface AuthenticatedRequest extends Request {
  credential?: Credential;
}

const INVALID = 'Missing or invalid credentials';
const LAST_USED_PRECISION_MS = 60_000;
const REFUSAL_RECORDED_EVERY_MS = 15 * 60_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
 *
 * It also holds every route to the action it declares (`@Requires`). The check itself lives in
 * the service, which has the resource; but if the handler finishes and the policy was never asked
 * about that action, the request fails and its transaction rolls back. Forgetting the check is a
 * 500 in the first test that touches the route, not a hole.
 *
 * A refusal (403) is itself recorded. The request's own transaction has rolled back by then, so
 * the event is written in one of its own: someone trying doors they may not open leaves a trace.
 */
@Injectable()
export class TenantInterceptor implements NestInterceptor {
  private readonly logger = new Logger('Authorization');
  private readonly refusals = new Map<string, number>(); // member + route + resource → when last recorded

  constructor(
    @Inject(DB) private readonly db: Kysely<Database>,
    private readonly tenant: TenantContext,
    private readonly reflector: Reflector,
    private readonly audit: AuditService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const { credential } = req;
    if (!credential) return next.handle();
    let who: Principal | undefined;
    const required = this.reflector.get<Action | typeof ANY_PRINCIPAL | undefined>(REQUIRES, context.getHandler());
    const route = `${context.getClass().name}.${context.getHandler().name}`;
    return from(withTenant(this.db, credential.orgId, async (trx) => {
      const principal = await loadPrincipal(trx, credential);
      if (!principal) throw new UnauthorizedException(INVALID);
      who = principal;
      return this.tenant.run({ trx, principal }, async () => {
        const result = await lastValueFrom(next.handle() as Observable<unknown>, { defaultValue: undefined });
        if (!required) {
          this.logger.error(`${route} declares no action (@Requires)`);
          throw new InternalServerErrorException();
        }
        if (required !== ANY_PRINCIPAL && !this.tenant.hasDecided(required)) {
          this.logger.error(`${route} answered without the policy being asked about ${required}`);
          throw new InternalServerErrorException();
        }
        return result;
      });
    }).catch(async (err: unknown) => {
      if (err instanceof ForbiddenException && who) await this.recordRefusal(who, req, required, err.message);
      throw err;
    }));
  }

  /**
   * One event per member, route and resource each quarter of an hour: a page that keeps asking for
   * what it was refused (a tab left open, a client retrying) is one refusal, not a full log.
   */
  private async recordRefusal(who: Principal, req: AuthenticatedRequest, required: string | undefined, reason: string): Promise<void> {
    const id: unknown = req.params.id;
    const key = `${who.id} ${req.method} ${(req.route as { path?: string } | undefined)?.path ?? ''} ${typeof id === 'string' ? id : ''}`;
    const now = Date.now();
    if (now - (this.refusals.get(key) ?? 0) < REFUSAL_RECORDED_EVERY_MS) return;
    this.refusals.set(key, now);
    if (this.refusals.size > 10_000) for (const [k, at] of this.refusals) if (now - at >= REFUSAL_RECORDED_EVERY_MS) this.refusals.delete(k);
    try {
      await withTenant(this.db, who.orgId, (trx) => this.audit.record(trx, who.orgId, actorOf(who), {
        action: 'access.denied',
        resourceType: 'request',
        resourceId: typeof id === 'string' && UUID.test(id) ? id : null,
        // The route as declared ("/documents/:id"), not the address asked for.
        detail: { method: req.method, route: (req.route as { path?: string } | undefined)?.path ?? null, required: required ?? null, reason },
      }));
    } catch (err) {
      this.logger.error(`could not record a refusal: ${err instanceof Error ? err.message : String(err)}`);
    }
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
