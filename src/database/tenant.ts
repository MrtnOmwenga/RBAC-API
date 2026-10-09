import { AsyncLocalStorage } from 'node:async_hooks';
import { Injectable } from '@nestjs/common';
import { type Kysely, sql, type Transaction } from 'kysely';
import type { Action, Principal } from '../policy/policy';
import type { Database } from './schema';

export const DB = Symbol('DB');

/**
 * Runs `fn` in a transaction whose row-level security is scoped to `orgId`. The setting is
 * transaction-local, so it can never leak to the next request that reuses the connection.
 */
export function withTenant<T>(db: Kysely<Database>, orgId: string, fn: (trx: Transaction<Database>) => Promise<T>): Promise<T> {
  return db.transaction().execute(async (trx) => {
    await sql`select set_config('app.org_id', ${orgId}, true)`.execute(trx);
    return fn(trx);
  });
}

interface Store {
  trx: Transaction<Database>;
  principal: Principal;
  /** The actions the policy has been asked about during this request. */
  decided: Set<Action>;
}

const storage = new AsyncLocalStorage<Store>();

/**
 * Notes that the policy was asked about `action` in the current request. Each route declares the
 * action it needs (`@Requires`), and a request that finishes without that action having been
 * decided fails (see TenantInterceptor): an endpoint that forgets to ask can't answer.
 */
export function decided(action: Action): void {
  storage.getStore()?.decided.add(action);
}

/** The current request's tenant transaction and principal (set by TenantInterceptor). */
@Injectable()
export class TenantContext {
  run<T>(store: Omit<Store, 'decided'>, fn: () => Promise<T>): Promise<T> {
    return storage.run({ ...store, decided: new Set() }, fn);
  }

  private get store(): Store {
    const store = storage.getStore();
    if (!store) throw new Error('No tenant context: this code must run inside an authenticated request');
    return store;
  }

  get db(): Transaction<Database> {
    return this.store.trx;
  }

  get principal(): Principal {
    return this.store.principal;
  }

  hasDecided(action: Action): boolean {
    return this.store.decided.has(action);
  }
}
