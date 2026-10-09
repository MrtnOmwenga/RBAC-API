import { Body, Controller, ForbiddenException, Get, HttpCode, Post, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { listScope, Requires, ZodPipe } from '../common/http';
import { TenantContext } from '../database/tenant';
import { AuditService } from './audit.service';

const filter = {
  actorId: z.uuid().optional(),
  resourceId: z.uuid().optional(),
  // An action ("member.update"), or a family of them with a trailing dot ("auth.").
  action: z.string().regex(/^[a-z_]+\.[a-z_]*$/).max(60).optional(),
  // Up to five actions to leave out, comma-separated.
  exclude: z.string().regex(/^[a-z_]+\.[a-z_]+(,[a-z_]+\.[a-z_]+){0,4}$/).transform((s) => s.split(',')).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
};
const seq = z.coerce.number().int().min(0);
const checkpointBody = z.strictObject({
  checkpoint: z.strictObject({
    orgId: z.uuid(), seq: z.number().int().min(0), hash: z.string().regex(/^[0-9a-f]{64}$/), at: z.iso.datetime(), signature: z.string().max(200),
  }),
});
const listQuery = z.strictObject({ ...filter, limit: z.coerce.number().int().min(1).max(500).default(100), before: seq.optional() });
const exportQuery = z.strictObject({ ...filter, limit: z.coerce.number().int().min(1).max(5000).default(5000), after: seq.optional() });

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
    return this.audit.list(this.tenant.db, this.tenant.principal.orgId, query);
  }

  /**
   * The log as newline-delimited JSON, oldest first, for an auditor's own tools. Each line carries
   * the event's hashes, so the chain can be checked from the file without trusting this API.
   */
  @Get('export')
  @Requires('audit:read')
  async export(@Query(new ZodPipe(exportQuery)) query: z.infer<typeof exportQuery>, @Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<string> {
    this.allowed();
    const page = await this.audit.export(this.tenant.db, this.tenant.principal.orgId, query);
    if (page.next !== null) {
      const url = new URL(req.originalUrl, 'http://relative');
      url.searchParams.set('after', page.next);
      res.setHeader('Link', `<${url.pathname}${url.search}>; rel="next"`);
    }
    res.type('application/x-ndjson').setHeader('Content-Disposition', 'attachment; filename="audit-events.ndjson"');
    return page.items.map((event) => `${JSON.stringify(event)}\n`).join('');
  }

  /**
   * Where the log ends right now, signed. Kept outside the database, it later shows what the chain
   * alone can't: the newest events removed, or everything from some point rewritten.
   */
  @Get('checkpoint')
  @Requires('audit:read')
  checkpoint() {
    this.allowed();
    return this.audit.checkpoint(this.tenant.db, this.tenant.principal.orgId);
  }

  @Get('checkpoint-key')
  @Requires('audit:read')
  checkpointKey() {
    this.allowed();
    return { algorithm: 'Ed25519', publicKey: this.audit.checkpointPublicKey };
  }

  /** Recomputes the chain and checks it against a checkpoint taken earlier. */
  @Post('verify')
  @HttpCode(200)
  @Requires('audit:read')
  verifyAgainst(@Body(new ZodPipe(checkpointBody)) body: z.infer<typeof checkpointBody>) {
    this.allowed();
    return this.audit.verifyAgainst(this.tenant.db, this.tenant.principal.orgId, body.checkpoint);
  }

  /** Recomputes the organization's whole hash chain and reports the first break, if any. */
  @Get('verify')
  @Requires('audit:read')
  verify() {
    this.allowed();
    return this.audit.verify(this.tenant.db, this.tenant.principal.orgId);
  }
}
