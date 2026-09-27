import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { z } from 'zod';
import { ZodPipe } from '../common/http';
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

@Controller('members')
export class MembersController {
  constructor(private readonly members: MembersService) {}

  @Post()
  create(@Body(new ZodPipe(createBody)) body: z.infer<typeof createBody>) {
    return this.members.create(body);
  }

  @Get()
  list() {
    return this.members.list();
  }

  @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.members.get(id);
  }

  @Patch(':id')
  update(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(updateBody)) body: z.infer<typeof updateBody>) {
    return this.members.update(id, body);
  }

  @Post(':id/disable')
  @HttpCode(204)
  async disable(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.members.disable(id);
  }
}
