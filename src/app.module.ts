import { randomUUID } from 'node:crypto';
import { type DynamicModule, type INestApplication, Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import helmet from 'helmet';
import { Logger, LoggerModule } from 'nestjs-pino';
import { ApiKeysController } from './api-keys/api-keys.controller';
import { ApiKeysService } from './api-keys/api-keys.service';
import { AuditController } from './audit/audit.controller';
import { AuditService } from './audit/audit.service';
import { AuthController, MeController } from './auth/auth.controller';
import { AuthService } from './auth/auth.service';
import { AuthenticationGuard, TenantInterceptor } from './auth/authentication';
import { BriefingsController } from './briefings/briefings.controller';
import { BriefingsService } from './briefings/briefings.service';
import { RealtimeService } from './realtime/realtime.service';
import { DemoController } from './demo/demo.controller';
import { DemoService } from './demo/demo.service';
import { ProblemDetailsFilter } from './common/http';
import { CONFIG, type Config } from './config/config';
import { DatabaseModule } from './database/database.module';
import { DepartmentsController } from './departments/departments.controller';
import { DepartmentsService } from './departments/departments.service';
import { DocumentsController } from './documents/documents.controller';
import { DocumentsService } from './documents/documents.service';
import { HealthController } from './health/health.controller';
import { MembersController } from './members/members.controller';
import { MembersService } from './members/members.service';
import { ProjectsController } from './projects/projects.controller';
import { ProjectsService } from './projects/projects.service';

const REQUEST_ID = /^[\w-]{1,64}$/;

@Module({})
export class AppModule {
  static forRoot(config: Config): DynamicModule {
    return {
      module: AppModule,
      imports: [
        { module: class ConfigModule {}, global: true, providers: [{ provide: CONFIG, useValue: config }], exports: [CONFIG] },
        LoggerModule.forRoot({
          pinoHttp: {
            level: config.LOG_LEVEL,
            // Credentials never reach the logs.
            redact: ['req.headers.authorization', 'req.headers["x-api-key"]', 'req.headers.cookie'],
            genReqId: (req, res) => {
              const incoming = req.headers['x-request-id'];
              const id = typeof incoming === 'string' && REQUEST_ID.test(incoming) ? incoming : randomUUID();
              res.setHeader('x-request-id', id);
              return id;
            },
            ...(config.NODE_ENV === 'development' ? { transport: { target: 'pino-pretty' } } : {}),
          },
        }),
        ThrottlerModule.forRoot([
          { name: 'default', ttl: 60_000, limit: config.RATE_LIMIT_PER_MINUTE },
          {
            // Login, sign-up and refresh get a much tighter budget: guessing credentials is the
            // attack they face. Creating demo agencies shares it. Keyed by client address.
            name: 'auth',
            ttl: 60_000,
            limit: config.AUTH_RATE_LIMIT_PER_MINUTE,
            skipIf: (ctx) => ctx.getClass() !== AuthController && ctx.getClass() !== DemoController,
          },
        ]),
        DatabaseModule,
      ],
      controllers: [
        AuthController, MeController, DepartmentsController, MembersController, ProjectsController, DocumentsController,
        ApiKeysController, AuditController, HealthController, BriefingsController, DemoController,
      ],
      providers: [
        AuditService, AuthService, DepartmentsService, MembersService, ProjectsService, DocumentsService, ApiKeysService, BriefingsService, RealtimeService, DemoService,
        { provide: APP_GUARD, useClass: ThrottlerGuard },
        { provide: APP_GUARD, useClass: AuthenticationGuard },
        { provide: APP_INTERCEPTOR, useClass: TenantInterceptor },
        { provide: APP_FILTER, useClass: ProblemDetailsFilter },
      ],
    };
  }
}

/** Settings shared by the server and the tests. */
export function configureApp(app: INestApplication): void {
  app.useLogger(app.get(Logger));
  app.use(helmet());
  const http = app.getHttpAdapter().getInstance() as { set(key: string, value: unknown): void };
  http.set('trust proxy', 1);
  app.enableShutdownHooks();
}

