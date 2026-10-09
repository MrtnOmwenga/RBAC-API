import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { Requires, ZodPipe } from '../common/http';
import { pageQuery } from '../common/pagination';
import { ROLES, TOP_CLEARANCE } from '../policy/policy';
import { MembersService } from './members.service';

const createBody = z.strictObject({
  email: z.email().max(254).transform((e) => e.toLowerCase()),
  name: z.string().trim().min(1).max(100),
  password: z.string().min(12).max(128),
  role: z.enum(ROLES),
  departmentId: z.uuid().nullable().default(null),
});
const updateBody = z.strictObject({
  role: z.enum(ROLES).optional(),
  departmentId: z.uuid().nullable().optional(),
  clearance: z.number().int().min(0).max(TOP_CLEARANCE).optional(),
}).refine((b) => b.role !== undefined || b.departmentId !== undefined || b.clearance !== undefined, 'Change the role, department or clearance');

const listQuery = z.strictObject(pageQuery);

@Controller('members')
export class MembersController {
  constructor(private readonly members: MembersService) {}

  @Post()
  @Requires('member:create')
  create(@Body(new ZodPipe(createBody)) body: z.infer<typeof createBody>) {
    return this.members.create(body);
  }

  @Get()
  @Requires('member:read')
  list(@Query(new ZodPipe(listQuery)) query: z.infer<typeof listQuery>) {
    return this.members.list(query);
  }

  @Get(':id')
  @Requires('member:read')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.members.get(id);
  }

  @Patch(':id')
  @Requires('member:update')
  update(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(updateBody)) body: z.infer<typeof updateBody>) {
    return this.members.update(id, body);
  }

  @Post(':id/disable')
  @HttpCode(204)
  @Requires('member:disable')
  async disable(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.members.disable(id);
  }
}
