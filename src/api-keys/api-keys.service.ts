import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { AuditService, actorOf } from '../audit/audit.service';
import { newApiKey } from '../auth/tokens';
import { authorize, listScope } from '../common/http';
import { findDepartment } from '../common/lookups';
import { TenantContext } from '../database/tenant';
import { type Action } from '../policy/policy';

interface KeyRow {
  id: string; name: string; prefix: string; scopes: Action[]; department_id: string | null;
  expires_at: Date | null; revoked_at: Date | null; last_used_at: Date | null; created_at: Date;
}

const view = (k: KeyRow) => ({
  id: k.id, name: k.name, prefix: k.prefix, scopes: k.scopes, departmentId: k.department_id,
  expiresAt: k.expires_at, revokedAt: k.revoked_at, lastUsedAt: k.last_used_at, createdAt: k.created_at,
});
const COLUMNS = ['id', 'name', 'prefix', 'scopes', 'department_id', 'expires_at', 'revoked_at', 'last_used_at', 'created_at'] as const;

@Injectable()
export class ApiKeysService {
  constructor(private readonly tenant: TenantContext, private readonly audit: AuditService) {}

  /** The full key is returned only here, once; the server keeps a hash of its secret. */
  async create(input: { name: string; scopes: Action[]; departmentId: string | null; expiresInDays: number | null }) {
    const { db, principal } = this.tenant;
    authorize(principal, 'api_key:create', { orgId: principal.orgId, departmentId: null });
    if (input.departmentId) await findDepartment(db, input.departmentId);
    const { key, prefix, secretHash } = newApiKey();
    const row = await db.insertInto('api_keys').values({
      org_id: principal.orgId, name: input.name, prefix, secret_hash: secretHash, scopes: input.scopes,
      department_id: input.departmentId, created_by: principal.id,
      expires_at: input.expiresInDays ? new Date(Date.now() + input.expiresInDays * 86_400_000) : null,
    }).returning(COLUMNS).executeTakeFirstOrThrow();
    await this.audit.record(db, principal.orgId, actorOf(principal), {
      action: 'api_key.create', resourceType: 'api_key', resourceId: row.id, detail: { scopes: input.scopes, departmentId: input.departmentId },
    });
    return { ...view(row), key };
  }

  async list() {
    const { db, principal } = this.tenant;
    if (!listScope(principal, 'api_key:read')) throw new ForbiddenException('Not allowed to api_key:read');
    return (await db.selectFrom('api_keys').select(COLUMNS).orderBy('created_at', 'desc').execute()).map(view);
  }

  async revoke(id: string) {
    const { db, principal } = this.tenant;
    const key = await db.selectFrom('api_keys').select(['id', 'org_id', 'revoked_at']).where('id', '=', id).executeTakeFirst();
    if (!key) throw new NotFoundException('No such API key');
    authorize(principal, 'api_key:revoke', { orgId: key.org_id, departmentId: null });
    if (key.revoked_at) return;
    await db.updateTable('api_keys').set({ revoked_at: new Date() }).where('id', '=', id).execute();
    await this.audit.record(db, principal.orgId, actorOf(principal), { action: 'api_key.revoke', resourceType: 'api_key', resourceId: id });
  }
}
