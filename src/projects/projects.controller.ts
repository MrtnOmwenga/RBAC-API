import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { z } from 'zod';
import { ZodPipe } from '../common/http';
import { ProjectsService } from './projects.service';

const name = z.string().trim().min(1).max(200);
const createBody = z.strictObject({ name, departmentId: z.uuid() });
const updateBody = z.strictObject({ name });

@Controller('projects')
export class ProjectsController {
  constructor(private readonly projects: ProjectsService) {}

  @Post()
  create(@Body(new ZodPipe(createBody)) body: z.infer<typeof createBody>) {
    return this.projects.create(body);
  }

  @Get()
  list() {
    return this.projects.list();
  }

  @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.projects.get(id);
  }

  @Patch(':id')
  rename(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(updateBody)) body: z.infer<typeof updateBody>) {
    return this.projects.rename(id, body.name);
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.projects.remove(id);
  }
}
