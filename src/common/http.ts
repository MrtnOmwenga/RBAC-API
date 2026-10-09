import {
  type ArgumentsHost, BadRequestException, Catch, type ExceptionFilter, ForbiddenException, HttpException,
  HttpStatus, Logger, type PipeTransform, SetMetadata,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import type { z } from 'zod';
import { decided } from '../database/tenant';
import { type Action, can, listFilter, type Principal, type Resource } from '../policy/policy';

export const IS_PUBLIC = 'isPublic';
/** Marks a route that needs no credentials (sign-up, login, refresh, health). */
export const Public = () => SetMetadata(IS_PUBLIC, true);

/** Validates and strips a body or query with a zod schema; unknown fields are rejected, not ignored. */
export class ZodPipe<T extends z.ZodType> implements PipeTransform<unknown, z.infer<T>> {
  constructor(private readonly schema: T) {}

  transform(value: unknown): z.infer<T> {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      throw new BadRequestException({
        detail: 'The request is invalid',
        errors: result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    return result.data;
  }
}

export const REQUIRES = 'requires';
/** For routes any signed-in principal may use, about themselves (`/me`). */
export const ANY_PRINCIPAL = 'any';
/**
 * The action a route needs. Declaring it doesn't check it: the service does, once it has loaded
 * the resource. But a request that finishes without the policy having been asked about this
 * action fails with a 500 and writes nothing, and a route that declares nothing fails a test.
 */
export const Requires = (action: Action | typeof ANY_PRINCIPAL) => SetMetadata(REQUIRES, action);

export function authorize(principal: Principal, action: Action, resource: Resource): void {
  decided(action);
  if (!can(principal, action, resource)) throw new ForbiddenException(`Not allowed to ${action}`);
}

/** Which rows a list may return: everything in the organization, one department, or nothing (null). */
export function listScope(principal: Principal, action: Action): { departmentId?: string } | null {
  decided(action);
  return listFilter(principal, action);
}

interface PgError {
  code?: string;
}

/**
 * Every error leaves as RFC 9457 problem details. Unknown errors are logged and reported as a
 * bare 500, so internals (SQL, stack traces) never reach the client.
 */
@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  private readonly logger = new Logger('Errors');

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    const req = host.switchToHttp().getRequest<Request>();
    let status: number = HttpStatus.INTERNAL_SERVER_ERROR;
    let extra: Record<string, unknown> = {};

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const body = exception.getResponse();
      if (typeof body === 'string') extra = { detail: body };
      else {
        const { detail, message, errors } = body as { detail?: string; message?: string | string[]; errors?: unknown };
        extra = { detail: detail ?? (Array.isArray(message) ? message.join('; ') : message), ...(errors ? { errors } : {}) };
      }
    } else if ((exception as PgError)?.code === '23505') {
      status = HttpStatus.CONFLICT;
      extra = { detail: 'That already exists' };
    } else if ((exception as PgError)?.code === '23503') {
      status = HttpStatus.BAD_REQUEST;
      extra = { detail: 'A referenced resource does not exist' };
    } else {
      this.logger.error(exception instanceof Error ? exception.stack : String(exception));
    }

    res.status(status).type('application/problem+json').json({
      type: 'about:blank',
      title: HttpStatus[status]?.toString().replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase()) ?? 'Error',
      status,
      ...extra,
      instance: req.originalUrl,
    });
  }
}
