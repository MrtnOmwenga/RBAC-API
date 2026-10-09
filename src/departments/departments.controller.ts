import { Body, Controller, Get, Post } from '@nestjs/common';
import { z } from 'zod';
import { Requires, ZodPipe } from '../common/http';
import { DepartmentsService } from './departments.service';

const createBody = z.strictObject({ name: z.string().trim().min(1).max(100) });

@Controller('departments')
export class DepartmentsController {
  constructor(private readonly departments: DepartmentsService) {}

  @Post()
  @Requires('department:create')
  create(@Body(new ZodPipe(createBody)) body: z.infer<typeof createBody>) {
    return this.departments.create(body.name);
  }

  @Get()
  @Requires('department:read')
  list() {
    return this.departments.list();
  }
}
