import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { z } from 'zod';
import { ZodPipe } from '../common/http';
import { type Action, INTEGRATION_ACTIONS } from '../policy/policy';
import { ApiKeysService } from './api-keys.service';

const createBody = z.strictObject({
  name: z.string().trim().min(1).max(100),
  // Only actions an integration can ever hold; anything else is a 400, not silently dropped.
  scopes: z.array(z.enum(INTEGRATION_ACTIONS as [Action, ...Action[]])).min(1)
    .refine((s) => new Set(s).size === s.length, 'Scopes must not repeat'),
  departmentId: z.uuid().nullable().default(null),
  expiresInDays: z.number().int().min(1).max(365).nullable().default(90),
});

@Controller('api-keys')
export class ApiKeysController {
  constructor(private readonly keys: ApiKeysService) {}

  @Post()
  create(@Body(new ZodPipe(createBody)) body: z.infer<typeof createBody>) {
    return this.keys.create(body);
  }

  @Get()
  list() {
    return this.keys.list();
  }

  @Delete(':id')
  @HttpCode(204)
  async revoke(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.keys.revoke(id);
  }
}
