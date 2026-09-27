import { Body, Controller, Get, Post } from '@nestjs/common';
import { z } from 'zod';
import { ZodPipe } from '../common/http';
import { DepartmentsService } from './departments.service';

const createBody = z.strictObject({ name: z.string().trim().min(1).max(100) });

@Controller('departments')
export class DepartmentsController {
  constructor(private readonly departments: DepartmentsService) {}

  @Post()
  create(@Body(new ZodPipe(createBody)) body: z.infer<typeof createBody>) {
    return this.departments.create(body.name);
  }

  @Get()
  list() {
    return this.departments.list();
  }
}
