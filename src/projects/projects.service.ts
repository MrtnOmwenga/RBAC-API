import { ForbiddenException, Injectable } from '@nestjs/common';
import { AuditService, actorOf } from '../audit/audit.service';
import { authorize } from '../common/http';
import { findDepartment, findProject } from '../common/lookups';
import { TenantContext } from '../database/tenant';
import { listFilter } from '../policy/policy';
import { AccessChanges } from '../realtime/access-changes';

type ProjectRow = Awaited<ReturnType<typeof findProject>>;

const view = (p: ProjectRow) => ({ id: p.id, name: p.name, departmentId: p.department_id, createdBy: p.created_by, createdAt: p.created_at });
const resourceOf = (p: ProjectRow) => ({ orgId: p.org_id, departmentId: p.department_id });

@Injectable()
export class ProjectsService {
  constructor(
    private readonly tenant: TenantContext,
    private readonly audit: AuditService,
    private readonly access: AccessChanges,
  ) {}

  async create(input: { name: string; departmentId: string }) {
    const { db, principal } = this.tenant;
    await findDepartment(db, input.departmentId);
    authorize(principal, 'project:create', { orgId: principal.orgId, departmentId: input.departmentId });
    const project = await db.insertInto('projects').values({
      org_id: principal.orgId, department_id: input.departmentId, name: input.name, created_by: principal.kind === 'user' ? principal.id : null,
    }).returningAll().executeTakeFirstOrThrow();
    await this.audit.record(db, principal.orgId, actorOf(principal), { action: 'project.create', resourceType: 'project', resourceId: project.id, detail: { name: input.name } });
    return view(project);
  }

  async list() {
    const { db, principal } = this.tenant;
    const filter = listFilter(principal, 'project:read');
    if (!filter) throw new ForbiddenException('Not allowed to project:read');
    let query = db.selectFrom('projects').selectAll().orderBy('created_at', 'desc').limit(100);
    if (filter.departmentId) query = query.where('department_id', '=', filter.departmentId);
    return (await query.execute()).map(view);
  }

  async get(id: string) {
    const { db, principal } = this.tenant;
    const project = await findProject(db, id);
    authorize(principal, 'project:read', resourceOf(project));
    return view(project);
  }

  async rename(id: string, name: string) {
    const { db, principal } = this.tenant;
    const project = await findProject(db, id);
    authorize(principal, 'project:update', resourceOf(project));
    const updated = await db.updateTable('projects').set({ name }).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
    await this.audit.record(db, principal.orgId, actorOf(principal), { action: 'project.update', resourceType: 'project', resourceId: id, detail: { name } });
    return view(updated);
  }

  async remove(id: string) {
    const { db, principal } = this.tenant;
    const project = await findProject(db, id);
    authorize(principal, 'project:delete', resourceOf(project));
    await db.deleteFrom('projects').where('id', '=', id).execute();
    await this.audit.record(db, principal.orgId, actorOf(principal), { action: 'project.delete', resourceType: 'project', resourceId: id });
    await this.access.announce(db, principal.orgId);
  }
}
