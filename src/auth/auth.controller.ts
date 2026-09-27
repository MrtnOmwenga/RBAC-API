import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import { z } from 'zod';
import { Public, ZodPipe } from '../common/http';
import { TenantContext } from '../database/tenant';
import { AuthService } from './auth.service';

const email = z.email().max(254).transform((e) => e.toLowerCase());
// Length over composition rules (NIST SP 800-63B); the upper bound keeps hashing cost bounded.
const password = z.string().min(12).max(128);

const signUpBody = z.strictObject({ organization: z.string().trim().min(1).max(100), name: z.string().trim().min(1).max(100), email, password });
const loginBody = z.strictObject({ email, password: z.string().min(1).max(128) });
const refreshBody = z.strictObject({ refreshToken: z.string().max(100) });

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post('signup')
  signUp(@Body(new ZodPipe(signUpBody)) body: z.infer<typeof signUpBody>) {
    return this.auth.signUp(body);
  }

  @Public()
  @Post('login')
  @HttpCode(200)
  login(@Body(new ZodPipe(loginBody)) body: z.infer<typeof loginBody>) {
    return this.auth.login(body.email, body.password);
  }

  @Public()
  @Post('refresh')
  @HttpCode(200)
  refresh(@Body(new ZodPipe(refreshBody)) body: z.infer<typeof refreshBody>) {
    return this.auth.refresh(body.refreshToken);
  }

  @Public()
  @Post('logout')
  @HttpCode(204)
  async logout(@Body(new ZodPipe(refreshBody)) body: z.infer<typeof refreshBody>): Promise<void> {
    await this.auth.logout(body.refreshToken);
  }
}

@Controller('me')
export class MeController {
  constructor(private readonly tenant: TenantContext) {}

  @Get()
  me() {
    return this.tenant.principal;
  }
}
