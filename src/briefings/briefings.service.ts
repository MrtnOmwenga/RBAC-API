import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { AuditService, actorOf } from '../audit/audit.service';
import { findDepartment, findMember } from '../common/lookups';
import { TenantContext } from '../database/tenant';
import {
  type Access, can, canClassify, CLEARANCES, type Clearance, documentAccess, POLICY, sectionAccess,
} from '../policy/policy';
import { loadDocumentAccess, redactedLength } from './access';
import { AccessChanges } from '../realtime/access-changes';

export interface NewShare {
  subjectType: 'user' | 'department';
  subjectId: string;
  relation: 'reader' | 'editor';
  expiresInMinutes: number | null;
}

@Injectable()
export class BriefingsService {
  constructor(
    private readonly tenant: TenantContext,
    private readonly audit: AuditService,
    private readonly access: AccessChanges,
  ) {}

  /**
   * The document as this principal may see it: every section is listed (so the page keeps its
   * shape), but a section they aren't cleared for arrives only as a redaction: no heading, no text,
   * and a rounded length.
   */
  async get(documentId: string) {
    const { db, principal } = this.tenant;
    const { document, access } = await loadDocumentAccess(db, principal, documentId);
    if (access === 'none') throw new ForbiddenException('Not allowed to document:read');
    const sections = await db.selectFrom('document_sections').select(['id', 'position', 'heading', 'classification', 'text_length'])
      .where('document_id', '=', documentId).orderBy('position').execute();
    return {
      id: document.id,
      title: document.title,
      departmentId: document.department_id,
      access,
      canShare: can(principal, 'document:share', { orgId: document.org_id, departmentId: document.department_id, ownerId: document.author_id }),
      clearance: principal.kind === 'user' ? principal.clearance : 0,
      sections: sections.map((s) => {
        const sectionLevel = sectionAccess(principal, access, s.classification);
        return sectionLevel === 'none'
          ? { id: s.id, position: s.position, classification: s.classification, access: sectionLevel, redactedLength: redactedLength(s.text_length) }
          : { id: s.id, position: s.position, classification: s.classification, access: sectionLevel, heading: s.heading };
      }),
    };
  }

  async addSection(documentId: string, input: { heading: string; classification: Clearance }) {
    const { db, principal } = this.tenant;
    const { document, access } = await loadDocumentAccess(db, principal, documentId);
    if (!canClassify(principal, access, 0, input.classification)) throw new ForbiddenException('Not allowed to add a section at that classification');
    const last = await db.selectFrom('document_sections').select(({ fn }) => fn.max('position').as('max')).where('document_id', '=', documentId).executeTakeFirst();
    const section = await db.insertInto('document_sections').values({
      org_id: document.org_id, document_id: documentId, position: (last?.max ?? 0) + 1, heading: input.heading,
      classification: input.classification, updated_at: new Date(),
    }).returning(['id', 'position', 'heading', 'classification']).executeTakeFirstOrThrow();
    await this.audit.record(db, principal.orgId, actorOf(principal), {
      action: 'section.create', resourceType: 'document', resourceId: documentId, detail: { section: section.id, classification: CLEARANCES[input.classification] },
    });
    await this.access.announce(db, principal.orgId);
    return section;
  }

  async updateSection(sectionId: string, changes: { heading?: string; classification?: Clearance }) {
    const { db, principal } = this.tenant;
    const section = await db.selectFrom('document_sections').selectAll().where('id', '=', sectionId).executeTakeFirst();
    if (!section) throw new NotFoundException('No such section');
    const { access } = await loadDocumentAccess(db, principal, section.document_id);
    const to = changes.classification ?? section.classification;
    if (!canClassify(principal, access, section.classification, to)) throw new ForbiddenException('Not allowed to change this section');
    await db.updateTable('document_sections').set({ ...changes, updated_at: new Date() }).where('id', '=', sectionId).execute();
    await this.audit.record(db, principal.orgId, actorOf(principal), {
      action: 'section.update', resourceType: 'document', resourceId: section.document_id,
      detail: { section: sectionId, ...(changes.classification !== undefined ? { from: CLEARANCES[section.classification], to: CLEARANCES[to] } : {}) },
    });
    await this.access.announce(db, principal.orgId);
  }

  async removeSection(sectionId: string) {
    const { db, principal } = this.tenant;
    const section = await db.selectFrom('document_sections').selectAll().where('id', '=', sectionId).executeTakeFirst();
    if (!section) throw new NotFoundException('No such section');
    const { access } = await loadDocumentAccess(db, principal, section.document_id);
    if (!canClassify(principal, access, section.classification, section.classification)) throw new ForbiddenException('Not allowed to remove this section');
    await db.deleteFrom('document_sections').where('id', '=', sectionId).execute();
    await this.audit.record(db, principal.orgId, actorOf(principal), { action: 'section.delete', resourceType: 'document', resourceId: section.document_id, detail: { section: sectionId } });
    await this.access.announce(db, principal.orgId);
  }

  async shares(documentId: string) {
    const { db, principal } = this.tenant;
    const { grants, resource } = await loadDocumentAccess(db, principal, documentId);
    if (!can(principal, 'document:share', resource)) throw new ForbiddenException('Not allowed to document:share');
    return grants;
  }

  /** Sharing reaches across departments (that's its point) but only to people in this organization. */
  async share(documentId: string, input: NewShare) {
    const { db, principal } = this.tenant;
    const { resource } = await loadDocumentAccess(db, principal, documentId);
    if (!can(principal, 'document:share', resource) || principal.kind !== 'user') throw new ForbiddenException('Not allowed to document:share');
    if (input.subjectType === 'user') await findMember(db, input.subjectId);
    else await findDepartment(db, input.subjectId);
    const expiresAt = input.expiresInMinutes ? new Date(Date.now() + input.expiresInMinutes * 60_000) : null;
    const grant = await db.insertInto('document_grants').values({
      org_id: principal.orgId, document_id: documentId, subject_type: input.subjectType, subject_id: input.subjectId,
      relation: input.relation, granted_by: principal.id, expires_at: expiresAt,
    }).onConflict((oc) => oc.columns(['document_id', 'subject_type', 'subject_id']).doUpdateSet({ relation: input.relation, expires_at: expiresAt, granted_by: principal.id }))
      .returning(['id']).executeTakeFirstOrThrow();
    await this.audit.record(db, principal.orgId, actorOf(principal), {
      action: 'document.share', resourceType: 'document', resourceId: documentId,
      detail: { subject: `${input.subjectType}:${input.subjectId}`, relation: input.relation, expiresAt },
    });
    await this.access.announce(db, principal.orgId);
    return { id: grant.id, ...input, expiresAt };
  }

  async unshare(documentId: string, grantId: string) {
    const { db, principal } = this.tenant;
    const { resource } = await loadDocumentAccess(db, principal, documentId);
    if (!can(principal, 'document:share', resource)) throw new ForbiddenException('Not allowed to document:share');
    const removed = await db.deleteFrom('document_grants').where('id', '=', grantId).where('document_id', '=', documentId).executeTakeFirst();
    if (Number(removed.numDeletedRows) === 0) throw new NotFoundException('No such share');
    await this.audit.record(db, principal.orgId, actorOf(principal), { action: 'document.unshare', resourceType: 'document', resourceId: documentId, detail: { grant: grantId } });
    await this.access.announce(db, principal.orgId);
  }

  /**
   * "Why can I see this?": every reason the member has access, and what their clearance hides.
   * Anyone may ask about themselves; asking about someone else needs member:read on them.
   */
  async explain(documentId: string, userId?: string) {
    const { db, principal } = this.tenant;
    let subject = principal;
    if (userId && userId !== principal.id) {
      const member = await findMember(db, userId);
      if (!can(principal, 'member:read', { orgId: member.org_id, departmentId: member.department_id })) throw new ForbiddenException('Not allowed to member:read');
      const row = await db.selectFrom('users').select('clearance').where('id', '=', userId).executeTakeFirstOrThrow();
      subject = { kind: 'user', id: member.id, orgId: member.org_id, role: member.role, departmentId: member.department_id, clearance: row.clearance };
    }
    const { document, grants, resource, access: askerAccess } = await loadDocumentAccess(db, principal, documentId);
    if (askerAccess === 'none' && subject.id !== principal.id) throw new ForbiddenException('Not allowed to document:read');
    const reasons: { source: 'role' | 'share'; access: Access; because: string }[] = [];
    if (subject.kind === 'user') {
      for (const action of ['document:update', 'document:read'] as const) {
        const reach = POLICY[action][subject.role];
        if (reach && can(subject, action, resource)) {
          reasons.push({ source: 'role', access: action === 'document:update' ? 'edit' : 'read', because: `role ${subject.role} (${reach} reach)` });
          break;
        }
      }
      const now = new Date();
      for (const g of grants) {
        const mine = g.subjectType === 'user' ? g.subjectId === subject.id : g.subjectId === subject.departmentId;
        if (mine && (g.expiresAt === null || g.expiresAt > now)) {
          reasons.push({
            source: 'share',
            access: g.relation === 'editor' ? 'edit' : 'read',
            because: `shared with ${g.subjectType === 'user' ? 'them directly' : 'their department'} as ${g.relation}${g.expiresAt ? ` until ${g.expiresAt.toISOString()}` : ''}`,
          });
        }
      }
    }
    const access = documentAccess(subject, resource, grants);
    const sections = await db.selectFrom('document_sections').select(['id', 'classification']).where('document_id', '=', document.id).orderBy('position').execute();
    const clearance = subject.kind === 'user' ? subject.clearance : 0;
    return {
      userId: subject.id,
      access,
      reasons,
      clearance: CLEARANCES[clearance],
      redactedSections: sections.filter((s) => s.classification > clearance).map((s) => ({ id: s.id, classification: CLEARANCES[s.classification] })),
    };
  }
}
