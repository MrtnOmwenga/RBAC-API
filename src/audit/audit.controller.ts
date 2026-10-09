import { Controller, ForbiddenException, Get, Query } from '@nestjs/common';
import { z } from 'zod';
import { listScope, Requires, ZodPipe } from '../common/http';
import { TenantContext } from '../database/tenant';
import { AuditService } from './audit.service';

const listQuery = z.strictObject({ limit: z.coerce.number().int().min(1).max(500).default(100) });

@Controller('audit-events')
export class AuditController {
  constructor(private readonly tenant: TenantContext, private readonly audit: AuditService) {}

  private allowed() {
    if (!listScope(this.tenant.principal, 'audit:read')) throw new ForbiddenException('Not allowed to audit:read');
  }

  @Get()
  @Requires('audit:read')
  list(@Query(new ZodPipe(listQuery)) query: z.infer<typeof listQuery>) {
    this.allowed();
    return this.audit.list(this.tenant.db, this.tenant.principal.orgId, query.limit);
  }

  /** Recomputes the organization's whole hash chain and reports the first break, if any. */
  @Get('verify')
  @Requires('audit:read')
  verify() {
    this.allowed();
    return this.audit.verify(this.tenant.db, this.tenant.principal.orgId);
  }
}
