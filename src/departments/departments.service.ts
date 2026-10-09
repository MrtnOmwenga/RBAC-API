import { ForbiddenException, Injectable } from '@nestjs/common';
import { AuditService, actorOf } from '../audit/audit.service';
import { authorize, listScope } from '../common/http';
import { TenantContext } from '../database/tenant';

const view = (d: { id: string; name: string; created_at: Date }) => ({ id: d.id, name: d.name, createdAt: d.created_at });

@Injectable()
export class DepartmentsService {
  constructor(private readonly tenant: TenantContext, private readonly audit: AuditService) {}

  async create(name: string) {
    const { db, principal } = this.tenant;
    authorize(principal, 'department:create', { orgId: principal.orgId, departmentId: null });
    const department = await db.insertInto('departments').values({ org_id: principal.orgId, name }).returningAll().executeTakeFirstOrThrow();
    await this.audit.record(db, principal.orgId, actorOf(principal), { action: 'department.create', resourceType: 'department', resourceId: department.id, detail: { name } });
    return view(department);
  }

  async list() {
    const { db, principal } = this.tenant;
    const filter = listScope(principal, 'department:read');
    if (!filter) throw new ForbiddenException('Not allowed to department:read');
    let query = db.selectFrom('departments').selectAll().orderBy('name');
    if (filter.departmentId) query = query.where('id', '=', filter.departmentId);
    return (await query.execute()).map(view);
  }
}
