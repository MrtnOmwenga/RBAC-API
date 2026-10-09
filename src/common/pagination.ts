import { BadRequestException, type CallHandler, type ExecutionContext, Injectable, type NestInterceptor } from '@nestjs/common';
import type { Request, Response } from 'express';
import { type SelectQueryBuilder, sql } from 'kysely';
import { map, type Observable } from 'rxjs';
import { z } from 'zod';

/*
 * Lists are paged by keyset: "the rows after this one", not "skip N rows". A page costs the same
 * however deep it is, and rows added or removed while someone pages never shift what they see.
 *
 * The body stays a plain array. When there is more, the response carries the next page's address
 * in a Link header (RFC 8288, rel="next"), built from an opaque cursor.
 */

export const pageQuery = {
  limit: z.coerce.number().int().min(1).max(100).default(100),
  cursor: z.string().max(300).optional(),
};
export interface PageRequest { limit: number; cursor?: string | undefined }

/** One page of a list, and the cursor for the next (null on the last page). */
export class Page<T> {
  constructor(readonly items: T[], readonly next: string | null, readonly param = 'cursor') {}

  map<U>(fn: (item: T) => U): Page<U> {
    return new Page(this.items.map(fn), this.next, this.param);
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

function readCursor(cursor: string, kind: 'time' | 'text'): [string, string] {
  try {
    const [value, id] = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as [unknown, unknown];
    if (typeof value === 'string' && typeof id === 'string' && UUID.test(id) && (kind === 'text' || TIME.test(value))) return [value, id];
  } catch {
    // not a cursor this API issued
  }
  throw new BadRequestException('Invalid cursor');
}

/**
 * Runs `query` for one page, ordered by `column` and then `id` so the order is total. The cursor
 * holds the last row's exact sort value (a timestamp to the microsecond, which a JavaScript Date
 * would round) and its id.
 */
export async function pageOf<DB, TB extends keyof DB, O extends { id: string }>(
  query: SelectQueryBuilder<DB, TB, O>,
  by: { column: string; kind: 'time' | 'text'; direction: 'asc' | 'desc' },
  request: PageRequest,
): Promise<Page<O>> {
  const column = sql.ref(by.column);
  const key = by.kind === 'time'
    ? sql<string>`to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`
    : sql<string>`${column}::text`;
  let paged = query.select(key.as('page_key')).orderBy(column, by.direction).orderBy(sql.ref('id'), by.direction).limit(request.limit + 1);
  if (request.cursor) {
    const [value, id] = readCursor(request.cursor, by.kind);
    const bound = by.kind === 'time' ? sql`${value}::timestamptz` : sql`${value}`;
    paged = paged.where(sql<boolean>`(${column}, id) ${sql.raw(by.direction === 'desc' ? '<' : '>')} (${bound}, ${id}::uuid)`);
  }
  const rows = await paged.execute() as (O & { page_key: string })[];
  const items = rows.slice(0, request.limit);
  const last = items.at(-1);
  const next = rows.length > request.limit && last ? Buffer.from(JSON.stringify([last.page_key, last.id])).toString('base64url') : null;
  return new Page(items.map(({ page_key: _, ...row }) => row as unknown as O), next);
}

/** Sends a Page as its array, with the next page's address in a Link header when there is one. */
@Injectable()
export class PageInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(map((value: unknown) => {
      if (!(value instanceof Page)) return value;
      if (value.next !== null) {
        const http = context.switchToHttp();
        const url = new URL(http.getRequest<Request>().originalUrl, 'http://relative');
        url.searchParams.set(value.param, value.next);
        http.getResponse<Response>().setHeader('Link', `<${url.pathname}${url.search}>; rel="next"`);
      }
      return value.items as unknown;
    }));
  }
}
