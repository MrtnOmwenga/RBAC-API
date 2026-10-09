import { ForbiddenException, Injectable } from '@nestjs/common';
import { AuditService, actorOf } from '../audit/audit.service';
import { AuthService } from '../auth/auth.service';
import { hashPassword } from '../auth/passwords';
import { authorize, listScope } from '../common/http';
import { findDepartment, findMember } from '../common/lookups';
import { pageOf, type PageRequest } from '../common/pagination';
import { TenantContext } from '../database/tenant';
import { canAssignRole, canManageMember, canSetClearance, CLEARANCES, hasDepartment, type Role } from '../policy/policy';
import { AccessChanges } from '../realtime/access-changes';

type MemberRow = Awaited<ReturnType<typeof findMember>>;

const view = (m: MemberRow) => ({
  id: m.id, email: m.email, name: m.name, role: m.role, departmentId: m.department_id, clearance: m.clearance,
  disabled: m.disabled_at !== null, createdAt: m.created_at,
});

export interface NewMember {
  email: string;
  name: string;
  password: string;
  role: Role;
  departmentId: string | null;
}

@Injectable()
export class MembersService {
  constructor(
    private readonly tenant: TenantContext,
    private readonly audit: AuditService, private readonly auth: AuthService,
    private readonly access: AccessChanges,
  ) {}

  async create(input: NewMember) {
    const { db, principal } = this.tenant;
    if (input.departmentId) await findDepartment(db, input.departmentId);
    authorize(principal, 'member:create', { orgId: principal.orgId, departmentId: input.departmentId });
    if (!canAssignRole(principal, { role: input.role, departmentId: input.departmentId })) throw new ForbiddenException(`Not allowed to create a ${input.role} there`);
    const member = await db.insertInto('users').values({
      org_id: principal.orgId, email: input.email, name: input.name, password_hash: await hashPassword(input.password),
      role: input.role, department_id: input.departmentId,
    }).returning(['id', 'org_id', 'email', 'name', 'role', 'department_id', 'clearance', 'disabled_at', 'created_at']).executeTakeFirstOrThrow();
    await this.audit.record(db, principal.orgId, actorOf(principal), {
      action: 'member.create', resourceType: 'user', resourceId: member.id, detail: { role: input.role, departmentId: input.departmentId },
    });
    return view(member);
  }

  async list(page: PageRequest) {
    const { db, principal } = this.tenant;
    const filter = listScope(principal, 'member:read');
    if (!filter) throw new ForbiddenException('Not allowed to member:read');
    let query = db.selectFrom('users').select(['id', 'org_id', 'email', 'name', 'role', 'department_id', 'clearance', 'disabled_at', 'created_at']);
    if (filter.departmentId) query = query.where('department_id', '=', filter.departmentId);
    return (await pageOf(query, { column: 'name', kind: 'text', direction: 'asc' }, page)).map(view);
  }

  async get(id: string) {
    const { db, principal } = this.tenant;
    const member = await findMember(db, id);
    authorize(principal, 'member:read', { orgId: member.org_id, departmentId: member.department_id });
    return view(member);
  }

  /**
   * Changes role, department and/or clearance. A new role/department must be one the actor may
   * assign; clearance is for organization admins only, and never above their own.
   */
  async update(id: string, changes: { role?: Role; departmentId?: string | null; clearance?: number }) {
    const { db, principal } = this.tenant;
    const member = await findMember(db, id);
    authorize(principal, 'member:update', { orgId: member.org_id, departmentId: member.department_id });
    const current = { id: member.id, role: member.role, departmentId: member.department_id };
    if (!canManageMember(principal, current)) throw new ForbiddenException('Not allowed to manage this member');

    const role = changes.role ?? member.role;
    const departmentId = changes.departmentId !== undefined ? changes.departmentId : (hasDepartment(role) ? member.department_id : null);
    if (changes.role !== undefined || changes.departmentId !== undefined) {
      if (departmentId) await findDepartment(db, departmentId);
      if (!canAssignRole(principal, { id: member.id, role, departmentId })) throw new ForbiddenException(`Not allowed to make this member a ${role} there`);
    }
    const clearance = changes.clearance ?? member.clearance;
    if (changes.clearance !== undefined && !canSetClearance(principal, member, changes.clearance)) {
      throw new ForbiddenException(`Not allowed to grant ${CLEARANCES[changes.clearance] ?? 'that'} clearance`);
    }

    const updated = await db.updateTable('users').set({ role, department_id: departmentId, clearance }).where('id', '=', id)
      .returning(['id', 'org_id', 'email', 'name', 'role', 'department_id', 'clearance', 'disabled_at', 'created_at']).executeTakeFirstOrThrow();
    await this.audit.record(db, principal.orgId, actorOf(principal), {
      action: 'member.update', resourceType: 'user', resourceId: id,
      detail: {
        from: { role: member.role, departmentId: member.department_id, clearance: CLEARANCES[member.clearance] },
        to: { role, departmentId, clearance: CLEARANCES[clearance] },
      },
    });
    await this.access.announce(db, principal.orgId, { member: id });
    return view(updated);
  }

  /** Disables an account; its sessions end immediately (see TenantInterceptor and refresh). */
  async disable(id: string) {
    const { db, principal } = this.tenant;
    const member = await findMember(db, id);
    authorize(principal, 'member:disable', { orgId: member.org_id, departmentId: member.department_id });
    if (!canManageMember(principal, { id: member.id, role: member.role, departmentId: member.department_id })) {
      throw new ForbiddenException('Not allowed to manage this member');
    }
    await db.updateTable('users').set({ disabled_at: new Date() }).where('id', '=', id).execute();
    await this.auth.revokeAllFor(db, id);
    await this.audit.record(db, principal.orgId, actorOf(principal), { action: 'member.disable', resourceType: 'user', resourceId: id });
    await this.access.announce(db, principal.orgId, { member: id });
  }
}
