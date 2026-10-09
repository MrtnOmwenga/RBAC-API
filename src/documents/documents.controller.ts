import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { Requires, ZodPipe } from '../common/http';
import { pageQuery } from '../common/pagination';
import { DocumentsService } from './documents.service';

const title = z.string().trim().min(1).max(200);
const body = z.string().max(100_000);
const createBody = z.strictObject({ title, body });
const updateBody = z.strictObject({ title: title.optional(), body: body.optional() })
  .refine((b) => b.title !== undefined || b.body !== undefined, 'Change the title, the body or both');
const listQuery = z.strictObject({ ...pageQuery, projectId: z.uuid().optional() });

@Controller()
export class DocumentsController {
  constructor(private readonly documents: DocumentsService) {}

  @Post('projects/:projectId/documents')
  @Requires('document:create')
  create(@Param('projectId', ParseUUIDPipe) projectId: string, @Body(new ZodPipe(createBody)) input: z.infer<typeof createBody>) {
    return this.documents.create(projectId, input);
  }

  @Get('documents')
  @Requires('document:read')
  list(@Query(new ZodPipe(listQuery)) query: z.infer<typeof listQuery>) {
    return this.documents.list(query, query.projectId);
  }

  @Get('documents/:id')
  @Requires('document:read')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.documents.get(id);
  }

  @Patch('documents/:id')
  @Requires('document:update')
  update(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(updateBody)) input: z.infer<typeof updateBody>) {
    return this.documents.update(id, input);
  }

  @Delete('documents/:id')
  @HttpCode(204)
  @Requires('document:delete')
  async remove(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.documents.remove(id);
  }
}
