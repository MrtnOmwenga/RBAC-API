import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { ZodPipe } from '../common/http';
import { TOP_CLEARANCE } from '../policy/policy';
import { BriefingsService } from './briefings.service';

const classification = z.number().int().min(0).max(TOP_CLEARANCE);
const heading = z.string().trim().min(1).max(200);
const sectionBody = z.strictObject({ heading, classification: classification.default(0) });
const sectionUpdate = z.strictObject({ heading: heading.optional(), classification: classification.optional() })
  .refine((b) => b.heading !== undefined || b.classification !== undefined, 'Change the heading, the classification or both');
const shareBody = z.strictObject({
  subjectType: z.enum(['user', 'department']),
  subjectId: z.uuid(),
  relation: z.enum(['reader', 'editor']),
  expiresInMinutes: z.number().int().min(1).max(60 * 24 * 30).nullable().default(null),
});
const explainQuery = z.strictObject({ userId: z.uuid().optional() });

@Controller()
export class BriefingsController {
  constructor(private readonly briefings: BriefingsService) {}

  @Get('documents/:id/briefing')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.briefings.get(id);
  }

  @Post('documents/:id/sections')
  addSection(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(sectionBody)) body: z.infer<typeof sectionBody>) {
    return this.briefings.addSection(id, body);
  }

  @Patch('sections/:id')
  @HttpCode(204)
  async updateSection(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(sectionUpdate)) body: z.infer<typeof sectionUpdate>): Promise<void> {
    await this.briefings.updateSection(id, body);
  }

  @Delete('sections/:id')
  @HttpCode(204)
  async removeSection(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.briefings.removeSection(id);
  }

  @Get('documents/:id/shares')
  shares(@Param('id', ParseUUIDPipe) id: string) {
    return this.briefings.shares(id);
  }

  @Post('documents/:id/shares')
  share(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(shareBody)) body: z.infer<typeof shareBody>) {
    return this.briefings.share(id, body);
  }

  @Delete('documents/:id/shares/:grantId')
  @HttpCode(204)
  async unshare(@Param('id', ParseUUIDPipe) id: string, @Param('grantId', ParseUUIDPipe) grantId: string): Promise<void> {
    await this.briefings.unshare(id, grantId);
  }

  @Get('documents/:id/explain')
  explain(@Param('id', ParseUUIDPipe) id: string, @Query(new ZodPipe(explainQuery)) query: z.infer<typeof explainQuery>) {
    return this.briefings.explain(id, query.userId);
  }
}
