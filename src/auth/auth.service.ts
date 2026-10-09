import { randomUUID } from 'node:crypto';
import { ConflictException, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { type Kysely, sql, type Transaction } from 'kysely';
import { AuditService } from '../audit/audit.service';
import { sha256 } from '../common/crypto';
import { CONFIG, type Config } from '../config/config';
import type { Database } from '../database/schema';
import { DB, withTenant } from '../database/tenant';
import { HousekeepingService } from '../housekeeping/housekeeping.service';
import { hashPassword, verifyPassword } from './passwords';
import { newRefreshToken, REFRESH_TOKEN_FORMAT, signAccessToken } from './tokens';

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

/** Announces a session that has ended (`<organization>:<session>`), so open connections close. */
export const SESSION_CHANNEL = 'rbac_session_ended';

const INVALID_LOGIN = 'Invalid email or password';
const INVALID_REFRESH = 'Invalid refresh token';

type Outcome<T> = { ok: true; value: T } | { ok: false; error: Error };

@Injectable()
export class AuthService {
  constructor(
    @Inject(DB) private readonly db: Kysely<Database>,
    @Inject(CONFIG) private readonly config: Config,
    private readonly audit: AuditService,
    private readonly housekeeping: HousekeepingService,
  ) {}

  /** Creates an organization and its first administrator. */
  async signUp(input: { organization: string; name: string; email: string; password: string }): Promise<TokenPair & { userId: string; orgId: string }> {
    const orgId = randomUUID();
    const passwordHash = await hashPassword(input.password);
    try {
      return await withTenant(this.db, orgId, async (trx) => {
        await trx.insertInto('organizations').values({ id: orgId, name: input.organization }).execute();
        const user = await trx.insertInto('users').values({
          org_id: orgId, email: input.email, name: input.name, password_hash: passwordHash, role: 'org_admin', department_id: null,
        }).returning('id').executeTakeFirstOrThrow();
        await this.audit.record(trx, orgId, { actorType: 'user', actorId: user.id }, { action: 'organization.create', resourceType: 'organization', resourceId: orgId });
        return { ...(await this.issue(trx, orgId, user.id, randomUUID())), userId: user.id, orgId };
      });
    } catch (err) {
      if ((err as { code?: string }).code === '23505') throw new ConflictException('That email is already registered');
      throw err;
    }
  }

  /**
   * Same answer, and about the same time, for an unknown email, a wrong password, a locked or a
   * disabled account. Failed attempts are committed even though the request fails.
   */
  async login(email: string, password: string): Promise<TokenPair> {
    void this.housekeeping.nudge();
    const { rows } = await sql<{ id: string; org_id: string }>`select * from auth_login_lookup(${email})`.execute(this.db);
    const found = rows[0];
    if (!found) {
      await verifyPassword(null, password);
      throw new UnauthorizedException(INVALID_LOGIN);
    }
    const outcome = await withTenant(this.db, found.org_id, async (trx): Promise<Outcome<TokenPair>> => {
      const user = await trx.selectFrom('users').select(['id', 'password_hash', 'disabled_at', 'locked_until', 'failed_logins'])
        .where('id', '=', found.id).forUpdate().executeTakeFirstOrThrow();
      const locked = user.locked_until !== null && user.locked_until > new Date();
      const passwordOk = await verifyPassword(user.password_hash, password);
      const actor = { actorType: 'user' as const, actorId: user.id };

      if (locked || user.disabled_at !== null || !passwordOk) {
        if (!locked && !passwordOk) {
          const failures = user.failed_logins + 1;
          const lock = failures >= this.config.LOGIN_MAX_FAILURES;
          await trx.updateTable('users').where('id', '=', user.id).set({
            failed_logins: lock ? 0 : failures,
            locked_until: lock ? new Date(Date.now() + this.config.LOGIN_LOCK_MINUTES * 60_000) : user.locked_until,
          }).execute();
          await this.audit.record(trx, found.org_id, actor, { action: lock ? 'auth.locked' : 'auth.login_failed', resourceType: 'user', resourceId: user.id });
        }
        return { ok: false, error: new UnauthorizedException(INVALID_LOGIN) };
      }

      await trx.updateTable('users').where('id', '=', user.id).set({ failed_logins: 0, locked_until: null }).execute();
      await this.audit.record(trx, found.org_id, actor, { action: 'auth.login', resourceType: 'user', resourceId: user.id });
      return { ok: true, value: await this.issue(trx, found.org_id, user.id, randomUUID()) };
    });
    if (!outcome.ok) throw outcome.error;
    return outcome.value;
  }

  /**
   * Rotates a refresh token. Each token works once; presenting one that was already used means it
   * was copied, so the whole family (every token descended from that login) is revoked.
   */
  async refresh(refreshToken: string): Promise<TokenPair> {
    if (!REFRESH_TOKEN_FORMAT.test(refreshToken)) throw new UnauthorizedException(INVALID_REFRESH);
    const tokenHash = sha256(refreshToken);
    const { rows } = await sql<{ id: string; org_id: string }>`select * from auth_refresh_lookup(${tokenHash})`.execute(this.db);
    const found = rows[0];
    if (!found) throw new UnauthorizedException(INVALID_REFRESH);

    const outcome = await withTenant(this.db, found.org_id, async (trx): Promise<Outcome<TokenPair>> => {
      const token = await trx.selectFrom('refresh_tokens').selectAll().where('id', '=', found.id).forUpdate().executeTakeFirstOrThrow();
      const fail = { ok: false as const, error: new UnauthorizedException(INVALID_REFRESH) };
      if (token.revoked_at !== null || token.expires_at <= new Date()) return fail;
      if (token.used_at !== null) {
        await this.revokeFamily(trx, found.org_id, token.family_id);
        await this.audit.record(trx, found.org_id, { actorType: 'user', actorId: token.user_id }, {
          action: 'auth.refresh_reuse_detected', resourceType: 'user', resourceId: token.user_id, detail: { family: token.family_id },
        });
        return fail;
      }
      const user = await trx.selectFrom('users').select('id').where('id', '=', token.user_id).where('disabled_at', 'is', null).executeTakeFirst();
      if (!user) return fail;
      await trx.updateTable('refresh_tokens').set({ used_at: new Date() }).where('id', '=', token.id).execute();
      return { ok: true, value: await this.issue(trx, found.org_id, token.user_id, token.family_id) };
    });
    if (!outcome.ok) throw outcome.error;
    return outcome.value;
  }

  /**
   * Ends a session: its refresh token family stops working, and its open live connections are
   * closed. Unknown tokens are ignored.
   */
  async logout(refreshToken: string): Promise<void> {
    if (!REFRESH_TOKEN_FORMAT.test(refreshToken)) return;
    const { rows } = await sql<{ id: string; org_id: string }>`select * from auth_refresh_lookup(${sha256(refreshToken)})`.execute(this.db);
    const found = rows[0];
    if (!found) return;
    await withTenant(this.db, found.org_id, async (trx) => {
      const token = await trx.selectFrom('refresh_tokens').select(['family_id', 'user_id']).where('id', '=', found.id).executeTakeFirstOrThrow();
      await this.revokeFamily(trx, found.org_id, token.family_id);
      await this.audit.record(trx, found.org_id, { actorType: 'user', actorId: token.user_id }, { action: 'auth.logout', resourceType: 'user', resourceId: token.user_id });
    });
  }

  async revokeAllFor(trx: Transaction<Database>, userId: string): Promise<void> {
    await trx.updateTable('refresh_tokens').set({ revoked_at: new Date() }).where('user_id', '=', userId).where('revoked_at', 'is', null).execute();
  }

  private async revokeFamily(trx: Transaction<Database>, orgId: string, familyId: string): Promise<void> {
    await trx.updateTable('refresh_tokens').set({ revoked_at: new Date() }).where('family_id', '=', familyId).where('revoked_at', 'is', null).execute();
    // Delivered on commit, to every server instance.
    await sql`select pg_notify(${SESSION_CHANNEL}, ${`${orgId}:${familyId}`})`.execute(trx);
  }

  private async issue(trx: Transaction<Database>, orgId: string, userId: string, familyId: string): Promise<TokenPair> {
    const refresh = newRefreshToken();
    await trx.insertInto('refresh_tokens').values({
      org_id: orgId, user_id: userId, family_id: familyId, token_hash: refresh.hash,
      expires_at: new Date(Date.now() + this.config.REFRESH_TOKEN_TTL_DAYS * 86_400_000),
    }).execute();
    return {
      accessToken: signAccessToken(this.config.JWT_SECRET, this.config.ACCESS_TOKEN_TTL_SECONDS, { userId, orgId, sessionId: familyId }),
      refreshToken: refresh.token,
      expiresIn: this.config.ACCESS_TOKEN_TTL_SECONDS,
    };
  }
}
