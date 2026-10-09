import { ForbiddenException, Injectable } from '@nestjs/common';
import { AuditService, actorOf } from '../audit/audit.service';
import { authorize, listScope } from '../common/http';
import { findDocument, findProject } from '../common/lookups';
import { TenantContext } from '../database/tenant';
import { loadDocumentAccess } from '../briefings/access';
import { AccessChanges } from '../realtime/access-changes';

type DocumentRow = Awaited<ReturnType<typeof findDocument>>;

const view = (d: DocumentRow) => ({
  id: d.id, projectId: d.project_id, departmentId: d.department_id, title: d.title, body: d.body,
  authorId: d.author_id, apiKeyId: d.api_key_id, createdAt: d.created_at, updatedAt: d.updated_at,
});
// A document is "own" to the member who wrote it; documents written by integrations belong to nobody.
const resourceOf = (d: DocumentRow) => ({ orgId: d.org_id, departmentId: d.department_id, ownerId: d.author_id });

@Injectable()
export class DocumentsService {
  constructor(
    private readonly tenant: TenantContext,
    private readonly audit: AuditService,
    private readonly access: AccessChanges,
  ) {}

  async create(projectId: string, input: { title: string; body: string }) {
    const { db, principal } = this.tenant;
    const project = await findProject(db, projectId);
    authorize(principal, 'document:create', { orgId: project.org_id, departmentId: project.department_id });
    const document = await db.insertInto('documents').values({
      org_id: principal.orgId, project_id: project.id, department_id: project.department_id, title: input.title, body: input.body,
      author_id: principal.kind === 'user' ? principal.id : null,
      api_key_id: principal.kind === 'integration' ? principal.id : null,
      updated_at: new Date(),
    }).returningAll().executeTakeFirstOrThrow();
    await this.audit.record(db, principal.orgId, actorOf(principal), { action: 'document.create', resourceType: 'document', resourceId: document.id, detail: { projectId } });
    return view(document);
  }

  /** What the role reaches, plus anything shared with the member or their department. */
  async list(projectId?: string) {
    const { db, principal } = this.tenant;
    const filter = listScope(principal, 'document:read');
    const now = new Date();
    const shared = principal.kind === 'user'
      ? db.selectFrom('document_grants').select('document_id')
        .where((eb) => eb.or([
          eb.and([eb('subject_type', '=', 'user'), eb('subject_id', '=', principal.id)]),
          ...(principal.departmentId ? [eb.and([eb('subject_type', '=', 'department'), eb('subject_id', '=', principal.departmentId)])] : []),
        ]))
        .where((eb) => eb.or([eb('expires_at', 'is', null), eb('expires_at', '>', now)]))
      : null;
    if (!filter && !shared) throw new ForbiddenException('Not allowed to document:read');
    let query = db.selectFrom('documents').selectAll().orderBy('updated_at', 'desc').limit(100);
    query = query.where((eb) => {
      const byRole = filter ? (filter.departmentId ? eb('department_id', '=', filter.departmentId) : eb.lit(true)) : eb.lit(false);
      return shared ? eb.or([byRole, eb('id', 'in', shared)]) : byRole;
    });
    if (projectId) query = query.where('project_id', '=', projectId);
    return (await query.execute()).map(view);
  }

  async get(id: string) {
    const { db, principal } = this.tenant;
    const { document, access } = await loadDocumentAccess(db, principal, id);
    if (access === 'none') throw new ForbiddenException('Not allowed to document:read');
    return view(document);
  }

  async update(id: string, changes: { title?: string; body?: string }) {
    const { db, principal } = this.tenant;
    const { access } = await loadDocumentAccess(db, principal, id);
    if (access !== 'edit') throw new ForbiddenException('Not allowed to document:update');
    const updated = await db.updateTable('documents').set({ ...changes, updated_at: new Date() }).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
    await this.audit.record(db, principal.orgId, actorOf(principal), { action: 'document.update', resourceType: 'document', resourceId: id, detail: { fields: Object.keys(changes) } });
    return view(updated);
  }

  async remove(id: string) {
    const { db, principal } = this.tenant;
    const document = await findDocument(db, id);
    authorize(principal, 'document:delete', resourceOf(document));
    await db.deleteFrom('documents').where('id', '=', id).execute();
    await this.audit.record(db, principal.orgId, actorOf(principal), { action: 'document.delete', resourceType: 'document', resourceId: id });
    await this.access.announce(db, principal.orgId);
  }
}
