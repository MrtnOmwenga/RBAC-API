import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { Requires, ZodPipe } from '../common/http';
import { pageQuery } from '../common/pagination';
import { ProjectsService } from './projects.service';

const name = z.string().trim().min(1).max(200);
const createBody = z.strictObject({ name, departmentId: z.uuid() });
const updateBody = z.strictObject({ name });

const listQuery = z.strictObject(pageQuery);

@Controller('projects')
export class ProjectsController {
  constructor(private readonly projects: ProjectsService) {}

  @Post()
  @Requires('project:create')
  create(@Body(new ZodPipe(createBody)) body: z.infer<typeof createBody>) {
    return this.projects.create(body);
  }

  @Get()
  @Requires('project:read')
  list(@Query(new ZodPipe(listQuery)) query: z.infer<typeof listQuery>) {
    return this.projects.list(query);
  }

  @Get(':id')
  @Requires('project:read')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.projects.get(id);
  }

  @Patch(':id')
  @Requires('project:update')
  rename(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(updateBody)) body: z.infer<typeof updateBody>) {
    return this.projects.rename(id, body.name);
  }

  @Delete(':id')
  @HttpCode(204)
  @Requires('project:delete')
  async remove(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.projects.remove(id);
  }
}
