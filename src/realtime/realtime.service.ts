import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { type Connection, Hocuspocus } from '@hocuspocus/server';
import type { Kysely, Transaction } from 'kysely';
import { Client } from 'pg';
import { WebSocketServer } from 'ws';
import * as Y from 'yjs';
import { AuditService } from '../audit/audit.service';
import { loadPrincipal } from '../auth/authentication';
import { verifyAccessToken } from '../auth/tokens';
import { ACCESS_CHANNEL, loadDocumentAccess } from '../briefings/access';
import { CONFIG, type Config } from '../config/config';
import type { Database } from '../database/schema';
import { DB, withTenant } from '../database/tenant';
import { type Access, type Principal, sectionAccess } from '../policy/policy';

/*
 * Live collaborative editing (Yjs over WebSockets, via Hocuspocus), with the same authorization as
 * the REST API applied to every connection and re-applied whenever permissions change:
 *
 * - `section:<id>` rooms carry one section's text. Joining needs section access (document access
 *   *and* clearance); readers get read-only connections, so their updates are dropped. A section
 *   the user isn't cleared for is never synced to them, so hidden text never reaches the browser.
 * - `briefing:<id>` rooms carry no text; they tell every open reader when the briefing's shape or
 *   their access changed, so the page can re-fetch it.
 * - Any permission change is announced with pg_notify (see briefings/access.ts). Each server
 *   re-checks its open connections for that organization: lost access sends an `access: none`
 *   message and closes the connection, a demotion makes it read-only mid-edit, a promotion makes it writable.
 *
 * The access token travels in the first WebSocket message, not in a cookie, so there is no ambient
 * credential for a cross-site page to ride on.
 */

type Target = { kind: 'section' | 'briefing'; id: string };
interface Context {
  userId: string;
  orgId: string;
  target: Target;
  access: Access;
}

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const ROOM = new RegExp(`^(section|briefing):(${UUID})$`, 'i');

export function parseRoom(name: string): Target | null {
  const match = ROOM.exec(name);
  return match ? { kind: match[1]!.toLowerCase() as Target['kind'], id: match[2]!.toLowerCase() } : null;
}

/** Characters of text in a Yjs XML fragment (what TipTap edits), ignoring markup. */
export function textLength(node: Y.XmlFragment | Y.XmlElement | Y.XmlText): number {
  if (node instanceof Y.XmlText) {
    return (node.toDelta() as { insert: unknown }[]).reduce((n, op) => n + (typeof op.insert === 'string' ? op.insert.length : 0), 0);
  }
  return node.toArray().reduce((n, child) => n + (child instanceof Y.XmlHook ? 0 : textLength(child)), 0);
}

@Injectable()
export class RealtimeService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('Realtime');
  private readonly sockets = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  private readonly orgOf = new Map<string, string>(); // room name → organization
  private readonly editors = new Map<string, Set<string>>(); // room name → users who edited since the last save
  private readonly refreshing = new Map<string, Promise<void>>(); // organization → running re-check
  private listener?: Client;
  private closing = false;
  readonly hocuspocus: Hocuspocus<Context>;

  constructor(
    @Inject(DB) private readonly db: Kysely<Database>,
    @Inject(CONFIG) private readonly config: Config,
    private readonly adapterHost: HttpAdapterHost,
    private readonly audit: AuditService,
  ) {
    this.hocuspocus = new Hocuspocus<Context>({
      quiet: true,
      debounce: 1000,
      maxDebounce: 5000,
      onAuthenticate: (data) => this.authenticate(data.token, data.documentName, data.connectionConfig),
      onLoadDocument: async ({ document, documentName }) => {
        await this.load(documentName, document);
        return document;
      },
      onChange: async ({ documentName, context }) => {
        if (context?.userId) {
          const set = this.editors.get(documentName) ?? new Set<string>();
          set.add(context.userId);
          this.editors.set(documentName, set);
        }
        return Promise.resolve();
      },
      onStoreDocument: ({ document, documentName }) => this.store(documentName, document),
      afterUnloadDocument: ({ documentName }) => {
        this.orgOf.delete(documentName);
        return Promise.resolve();
      },
    });
  }

  async onApplicationBootstrap(): Promise<void> {
    const server = this.adapterHost.httpAdapter.getHttpServer() as import('node:http').Server;
    server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      if (!req.url?.startsWith('/collab')) {
        socket.destroy();
        return;
      }
      this.sockets.handleUpgrade(req, socket, head, (ws) => {
        const headers = new Headers();
        for (const [key, value] of Object.entries(req.headers)) if (typeof value === 'string') headers.set(key, value);
        const client = this.hocuspocus.handleConnection(ws, new Request(`http://localhost${req.url}`, { headers }));
        ws.on('message', (data: Buffer) => client.handleMessage(new Uint8Array(data)));
        ws.on('close', (code: number, reason: Buffer) => client.handleClose({ code, reason: reason.toString() }));
      });
    });
    await this.listen();
  }

  async onApplicationShutdown(): Promise<void> {
    this.closing = true;
    this.hocuspocus.flushPendingStores();
    this.hocuspocus.closeConnections();
    this.sockets.close();
    await this.listener?.end().catch(() => undefined);
    await Promise.all(this.refreshing.values());
  }

  /** Listens for permission changes from any server instance, reconnecting if the connection drops. */
  private async listen(): Promise<void> {
    const client = new Client({ connectionString: this.config.DATABASE_URL });
    client.on('notification', (msg) => { if (msg.payload) void this.refresh(msg.payload); });
    client.on('error', (err) => {
      this.logger.warn(`permission listener lost: ${err.message}`);
      if (!this.closing) setTimeout(() => { void this.listen(); }, 1000);
    });
    await client.connect();
    await client.query(`LISTEN ${ACCESS_CHANNEL}`);
    this.listener = client;
  }

  private async authenticate(token: string, room: string, connectionConfig: { readOnly: boolean }): Promise<Context> {
    const claims = verifyAccessToken(this.config.JWT_SECRET, token);
    const target = parseRoom(room);
    if (!claims || !target) throw new Error('unauthorized');
    const access = await withTenant(this.db, claims.orgId, async (trx) => {
      const principal = await loadPrincipal(trx, { kind: 'user', id: claims.userId, orgId: claims.orgId });
      return principal ? this.accessFor(trx, principal, target) : 'none';
    });
    if (access === 'none') throw new Error('forbidden');
    connectionConfig.readOnly = target.kind === 'briefing' || access !== 'edit';
    this.orgOf.set(room, claims.orgId);
    return { userId: claims.userId, orgId: claims.orgId, target, access };
  }

  private async accessFor(trx: Transaction<Database>, principal: Principal, target: Target): Promise<Access> {
    try {
      if (target.kind === 'briefing') return (await loadDocumentAccess(trx, principal, target.id)).access;
      const section = await trx.selectFrom('document_sections').select(['document_id', 'classification']).where('id', '=', target.id).executeTakeFirst();
      if (!section) return 'none';
      const { access } = await loadDocumentAccess(trx, principal, section.document_id);
      return sectionAccess(principal, access, section.classification);
    } catch {
      return 'none'; // the document is gone, or invisible under row-level security
    }
  }

  private async load(room: string, document: Y.Doc): Promise<void> {
    const target = parseRoom(room);
    const orgId = this.orgOf.get(room);
    if (target?.kind !== 'section' || !orgId) return;
    const row = await withTenant(this.db, orgId, (trx) => trx.selectFrom('document_sections').select('state').where('id', '=', target.id).executeTakeFirst());
    if (row?.state.length) Y.applyUpdate(document, new Uint8Array(row.state));
  }

  /** Saves a section (debounced by Hocuspocus) and records who edited it since the last save. */
  private async store(room: string, document: Y.Doc): Promise<void> {
    const target = parseRoom(room);
    const orgId = this.orgOf.get(room);
    if (target?.kind !== 'section' || !orgId) return;
    const editors = [...(this.editors.get(room) ?? [])];
    this.editors.delete(room);
    await withTenant(this.db, orgId, async (trx) => {
      const updated = await trx.updateTable('document_sections').set({
        state: Buffer.from(Y.encodeStateAsUpdate(document)),
        text_length: textLength(document.getXmlFragment('default')),
        updated_at: new Date(),
      }).where('id', '=', target.id).returning('document_id').executeTakeFirst();
      if (updated && editors.length) {
        await this.audit.record(trx, orgId, { actorType: 'user', actorId: editors[0]! }, {
          action: 'section.edit', resourceType: 'document', resourceId: updated.document_id, detail: { section: target.id, editors },
        });
      }
    });
  }

  /**
   * Re-checks every open connection in an organization after a permission change. Runs are
   * chained per organization so a burst of changes can't interleave.
   */
  refresh(orgId: string): Promise<void> {
    const previous = this.refreshing.get(orgId) ?? Promise.resolve();
    const run = previous.then(() => this.recheck(orgId)).catch((err: unknown) => {
      this.logger.error(`re-checking access failed: ${err instanceof Error ? err.message : String(err)}`);
    });
    this.refreshing.set(orgId, run);
    void run.finally(() => { if (this.refreshing.get(orgId) === run) this.refreshing.delete(orgId); });
    return run;
  }

  private async recheck(orgId: string): Promise<void> {
    for (const [room, document] of this.hocuspocus.documents) {
      if (this.orgOf.get(room) !== orgId) continue;
      for (const connection of document.getConnections() as Connection<Context>[]) {
        const { context } = connection;
        const access = await withTenant(this.db, orgId, async (trx) => {
          const principal = await loadPrincipal(trx, { kind: 'user', id: context.userId, orgId });
          return principal ? this.accessFor(trx, principal, context.target) : 'none';
        });
        if (access === 'none') {
          connection.sendStateless(JSON.stringify({ type: 'access', access }));
          connection.close({ code: 4403, reason: 'Access revoked' });
          continue;
        }
        if (context.target.kind === 'briefing') {
          connection.sendStateless(JSON.stringify({ type: 'refresh' }));
        } else {
          connection.readOnly = access !== 'edit';
        }
        if (access !== context.access) {
          context.access = access;
          connection.sendStateless(JSON.stringify({ type: 'access', access }));
        }
      }
    }
  }
}
