import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { type Connection, Hocuspocus, OutgoingMessage } from '@hocuspocus/server';
import type { Kysely, Transaction } from 'kysely';
import { Client } from 'pg';
import { createDecoder, readVarString, readVarUint, readVarUint8Array } from 'lib0/decoding';
import { WebSocketServer } from 'ws';
import * as Y from 'yjs';
import { AuditService } from '../audit/audit.service';
import { SESSION_CHANNEL } from '../auth/auth.service';
import { loadPrincipal } from '../auth/authentication';
import { verifyAccessToken } from '../auth/tokens';
import { ACCESS_CHANNEL, loadDocumentAccess } from '../briefings/access';
import { CONFIG, type Config } from '../config/config';
import type { Database } from '../database/schema';
import { DB, withTenant } from '../database/tenant';
import { type Access, CLEARANCES, type Principal, sectionView } from '../policy/policy';
import { FRAGMENT, maxMarkLevel, project } from './projection';

/*
 * Live collaborative editing (Yjs over WebSockets, via Hocuspocus), with the same authorization as
 * the REST API applied to every connection and re-applied whenever permissions change:
 *
 * - `section:<id>` rooms carry one section's text. Joining needs section access (document access
 *   *and* clearance); readers get read-only connections, so their updates are dropped. A section
 *   the user isn't cleared for is never synced to them, so hidden text never reaches the browser.
 * - `briefing:<id>` rooms carry no text; they tell every open reader when the briefing's shape or
 *   their access changed, so the page can re-fetch it.
 * - `member:<id>` rooms are personal: only that member may join. They ping on any access change in
 *   the organization, so even someone with no access yet learns when they've been given some.
 * - Words inside a section can be marked with a classification (docs/COLLABORATION.md, "mark to
 *   classify, project to read"). A section's full text is only for members cleared for every mark
 *   in it; others read `projection:<id>:<level>`, a read-only copy the server derives at their
 *   clearance with the words above it replaced by bars. Every update to a full text is checked
 *   *before* it is applied: marking above your own clearance closes your connection, and marking
 *   above a connected member's clearance disconnects them first, so they never receive what
 *   follows.
 * - Any permission change is announced with pg_notify (see briefings/access.ts). Each server
 *   re-checks its open connections for that organization: lost access sends an `access: none`
 *   message and closes the connection, a demotion makes it read-only mid-edit, a promotion makes it writable.
 * - Two things end access with no change to announce: a temporary share running out, and a token
 *   expiring. A sweep every few seconds covers both (`sweep`). Signing out is announced on its own
 *   channel and closes that session's connections on every server.
 *
 * The access token travels in the first WebSocket message, not in a cookie, so there is no ambient
 * credential for a cross-site page to ride on.
 */

type Target = { kind: 'section' | 'briefing' | 'member'; id: string } | { kind: 'projection'; id: string; level: number };
interface Context {
  userId: string;
  orgId: string;
  target: Target;
  access: Access;
  clearance: number;
  /** The login the token came from, if any: signing out of it closes this connection. */
  sessionId?: string;
  /** When the token that opened this connection stops being valid (milliseconds). */
  expiresAt: number;
}

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const ROOM = new RegExp(`^(section|briefing|member):(${UUID})$`, 'i');
const PROJECTION = new RegExp(`^projection:(${UUID}):([0-${CLEARANCES.length - 1}])$`, 'i');
const SYNC_MESSAGE = 0; // Hocuspocus message type carrying Yjs sync
const SYNC_STEP_2 = 1;
const SYNC_UPDATE = 2;

export function parseRoom(name: string): Target | null {
  const projection = PROJECTION.exec(name);
  if (projection) return { kind: 'projection', id: projection[1]!.toLowerCase(), level: Number(projection[2]) };
  const match = ROOM.exec(name);
  return match ? { kind: match[1]!.toLowerCase() as 'section' | 'briefing' | 'member', id: match[2]!.toLowerCase() } : null;
}

/** The Yjs update inside a raw client message, if it carries one. */
function updateIn(message: Uint8Array): Uint8Array | null {
  const decoder = createDecoder(message);
  readVarString(decoder); // the room name
  if (readVarUint(decoder) !== SYNC_MESSAGE) return null;
  const type = readVarUint(decoder);
  return type === SYNC_STEP_2 || type === SYNC_UPDATE ? readVarUint8Array(decoder) : null;
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
  private readonly locked = new Set<Connection<Context>>(); // made read-only pending a re-check
  private readonly fallbacks = new Map<string, NodeJS.Timeout>(); // organization → re-check if no notification comes
  private readonly reprojecting = new Map<string, NodeJS.Timeout>(); // section → pending projection rebuild
  private listener?: Client;
  private sweeper?: NodeJS.Timeout;
  private lastSweep = Date.now();
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
      beforeHandleMessage: ({ connection, document, update }) => this.guard(connection, document, update),
      onChange: async ({ documentName, context }) => {
        if (context?.userId) {
          const set = this.editors.get(documentName) ?? new Set<string>();
          set.add(context.userId);
          this.editors.set(documentName, set);
        }
        const target = parseRoom(documentName);
        if (target?.kind === 'section') this.scheduleProjection(target.id);
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
    // An open WebSocket keeps the instance awake, so this timer runs whenever it has work to do.
    this.sweeper = setInterval(() => { void this.sweep(); }, this.config.REALTIME_SWEEP_SECONDS * 1000);
    this.sweeper.unref();
  }

  async onApplicationShutdown(): Promise<void> {
    this.closing = true;
    clearInterval(this.sweeper);
    this.hocuspocus.flushPendingStores();
    this.hocuspocus.closeConnections();
    this.sockets.close();
    for (const timer of [...this.fallbacks.values(), ...this.reprojecting.values()]) clearTimeout(timer);
    await this.listener?.end().catch(() => undefined);
    await Promise.all(this.refreshing.values());
  }

  /** Listens for permission changes from any server instance, reconnecting if the connection drops. */
  private async listen(): Promise<void> {
    const client = new Client({ connectionString: this.config.DATABASE_URL });
    client.on('notification', (msg) => {
      if (!msg.payload) return;
      if (msg.channel === SESSION_CHANNEL) this.endSession(msg.payload);
      else void this.refresh(msg.payload);
    });
    client.on('error', (err) => {
      this.logger.warn(`permission listener lost: ${err.message}`);
      if (!this.closing) setTimeout(() => { void this.listen(); }, 1000);
    });
    await client.connect();
    await client.query(`LISTEN ${ACCESS_CHANNEL}; LISTEN ${SESSION_CHANNEL}`);
    this.listener = client;
  }

  private async authenticate(token: string, room: string, connectionConfig: { readOnly: boolean }): Promise<Context> {
    const claims = verifyAccessToken(this.config.JWT_SECRET, token);
    const target = parseRoom(room);
    if (!claims || !target) throw new Error('unauthorized');
    const { access, clearance } = await withTenant(this.db, claims.orgId, async (trx) => {
      const principal = await loadPrincipal(trx, { kind: 'user', id: claims.userId, orgId: claims.orgId });
      return {
        access: principal ? await this.accessFor(trx, principal, target) : 'none',
        clearance: principal?.kind === 'user' ? principal.clearance : 0,
      };
    });
    if (access === 'none') throw new Error('forbidden');
    connectionConfig.readOnly = target.kind !== 'section' || access !== 'edit';
    this.orgOf.set(room, claims.orgId);
    return {
      userId: claims.userId, orgId: claims.orgId, target, access, clearance,
      ...(claims.sessionId ? { sessionId: claims.sessionId } : {}), expiresAt: claims.expiresAt.getTime(),
    };
  }

  private *connections(orgId?: string): Generator<[Connection<Context>, string]> {
    for (const [room, document] of this.hocuspocus.documents) {
      const org = this.orgOf.get(room);
      if (!org || (orgId && org !== orgId)) continue;
      for (const connection of document.getConnections() as Connection<Context>[]) yield [connection, org];
    }
  }

  private end(connection: Connection<Context>, code: number, reason: string): void {
    this.locked.delete(connection);
    connection.sendStateless(JSON.stringify({ type: 'access', access: 'none' }));
    connection.close({ code, reason });
  }

  /** A member signed out (or their session was revoked as stolen): its connections close. */
  private endSession(payload: string): void {
    const [orgId, sessionId] = payload.split(':');
    if (!orgId || !sessionId) return;
    for (const [connection] of [...this.connections(orgId)]) {
      if (connection.context.sessionId === sessionId) this.end(connection, 4401, 'Signed out');
    }
  }

  /**
   * What no announcement covers, because nothing changed but the time. A connection never outlives
   * the token that opened it (the client reconnects with a fresh one), and when a temporary share
   * has run out since the last sweep, the organization's connections are re-checked.
   */
  async sweep(now = Date.now()): Promise<void> {
    const since = this.lastSweep;
    this.lastSweep = now;
    const orgs = new Set<string>();
    for (const [connection, orgId] of [...this.connections()]) {
      if (connection.context.expiresAt <= now) this.end(connection, 4401, 'Session expired');
      else orgs.add(orgId);
    }
    for (const orgId of orgs) {
      try {
        const lapsed = await withTenant(this.db, orgId, (trx) => trx.selectFrom('document_grants').select('id')
          .where('expires_at', '>', new Date(since)).where('expires_at', '<=', new Date(now)).limit(1).executeTakeFirst());
        if (lapsed) await this.refresh(orgId);
      } catch (err) {
        this.lastSweep = Math.min(this.lastSweep, since); // look at this stretch of time again
        this.logger.warn(`sweep failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  /** The highest level marked in a section: live if it's open (the stored value lags saves). */
  markedLevel(sectionId: string, stored: number): number {
    const live = this.hocuspocus.documents.get(`section:${sectionId}`);
    return live ? maxMarkLevel(live.getXmlFragment(FRAGMENT)) : stored;
  }

  /**
   * Checked before any update to a section's full text is applied. Marking words above your own
   * clearance closes your connection. Marking them above another connected member's clearance
   * disconnects that member first, so the update and everything after it never reach them; their
   * page then switches to the projection.
   */
  private guard(connection: Connection<Context>, document: Y.Doc, message: Uint8Array): Promise<void> {
    const { context } = connection;
    if (context?.target.kind !== 'section' || connection.readOnly) return Promise.resolve();
    const update = updateIn(message);
    if (!update) return Promise.resolve();
    const probe = new Y.Doc();
    Y.applyUpdate(probe, Y.encodeStateAsUpdate(document));
    Y.applyUpdate(probe, update);
    const after = maxMarkLevel(probe.getXmlFragment(FRAGMENT));
    probe.destroy();
    if (after > context.clearance) {
      throw Object.assign(new Error('marked above clearance'), { code: 4403, reason: 'Marked above your clearance' });
    }
    if (after <= maxMarkLevel(document.getXmlFragment(FRAGMENT))) return Promise.resolve();
    const open = (this.hocuspocus.documents.get(`section:${context.target.id}`)?.getConnections() ?? []) as Connection<Context>[];
    for (const other of open) {
      if (other !== connection && other.context.clearance < after) {
        other.sendStateless(JSON.stringify({ type: 'access', access: 'none' }));
        other.close({ code: 4403, reason: 'Section now above your clearance' });
      }
    }
    void this.refresh(context.orgId); // every page re-fetches: some now read a projection
    return Promise.resolve();
  }

  /** Rebuilds the open projections of a section shortly after its full text changes. */
  private scheduleProjection(sectionId: string): void {
    if (this.reprojecting.has(sectionId)) return;
    const timer = setTimeout(() => {
      this.reprojecting.delete(sectionId);
      void this.reproject(sectionId);
    }, 100);
    timer.unref();
    this.reprojecting.set(sectionId, timer);
  }

  private async reproject(sectionId: string, only?: { room: string; document: Y.Doc }): Promise<void> {
    const targets = only ? [[only.room, only.document] as const] : [...this.hocuspocus.documents]
      .filter(([room]) => room.startsWith(`projection:${sectionId}:`));
    if (targets.length === 0) return;
    let source = this.hocuspocus.documents.get(`section:${sectionId}`) as Y.Doc | undefined;
    if (!source) {
      const orgId = this.orgOf.get(targets[0]![0]);
      if (!orgId) return;
      const row = await withTenant(this.db, orgId, (trx) => trx.selectFrom('document_sections').select('state').where('id', '=', sectionId).executeTakeFirst());
      source = new Y.Doc();
      if (row?.state.length) Y.applyUpdate(source, new Uint8Array(row.state));
    }
    for (const [room, document] of targets) {
      const target = parseRoom(room);
      if (target?.kind !== 'projection') continue;
      document.transact(() => project(source.getXmlFragment(FRAGMENT), document.getXmlFragment(FRAGMENT), target.level), 'projection');
    }
  }

  private async accessFor(trx: Transaction<Database>, principal: Principal, target: Target): Promise<Access> {
    try {
      if (target.kind === 'member') return principal.id === target.id ? 'read' : 'none';
      if (target.kind === 'briefing') return (await loadDocumentAccess(trx, principal, target.id)).access;
      const section = await trx.selectFrom('document_sections').select(['document_id', 'classification', 'max_mark_level'])
        .where('id', '=', target.id).executeTakeFirst();
      if (!section) return 'none';
      const { access } = await loadDocumentAccess(trx, principal, section.document_id);
      const view = sectionView(principal, access, section.classification, this.markedLevel(target.id, section.max_mark_level));
      if (target.kind !== 'projection') return view.mode === 'full' ? view.access : 'none';
      // A projection is readable by anyone who may see the section, at or below their clearance.
      const clearance = principal.kind === 'user' ? principal.clearance : 0;
      return view.mode !== 'none' && target.level <= clearance && target.level >= section.classification ? 'read' : 'none';
    } catch {
      return 'none'; // the document is gone, or invisible under row-level security
    }
  }

  private async load(room: string, document: Y.Doc): Promise<void> {
    const target = parseRoom(room);
    const orgId = this.orgOf.get(room);
    if (target?.kind === 'projection' && orgId) {
      await this.reproject(target.id, { room, document });
      return;
    }
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
    const marked = maxMarkLevel(document.getXmlFragment(FRAGMENT));
    await withTenant(this.db, orgId, async (trx) => {
      const before = await trx.selectFrom('document_sections').select('max_mark_level').where('id', '=', target.id).executeTakeFirst();
      const updated = await trx.updateTable('document_sections').set({
        state: Buffer.from(Y.encodeStateAsUpdate(document)),
        text_length: textLength(document.getXmlFragment(FRAGMENT)),
        max_mark_level: marked,
        updated_at: new Date(),
      }).where('id', '=', target.id).returning('document_id').executeTakeFirst();
      if (updated && editors.length) {
        const markedChanged = before !== undefined && before.max_mark_level !== marked;
        await this.audit.record(trx, orgId, { actorType: 'user', actorId: editors[0]! }, {
          action: 'section.edit', resourceType: 'document', resourceId: updated.document_id,
          detail: { section: target.id, editors, ...(markedChanged ? { marked: { from: CLEARANCES[before.max_mark_level], to: CLEARANCES[marked] } } : {}) },
        });
      }
    });
  }

  /**
   * Fails closed: every section connection in the organization turns read-only now, before the
   * permission change commits. The re-check that follows the notification restores the ones still
   * allowed to write. If the change rolls back there is no notification, so a fallback re-check
   * runs after a few seconds either way.
   */
  lock(orgId: string): void {
    for (const connection of this.sectionConnections(orgId)) {
      if (!connection.readOnly) {
        connection.readOnly = true;
        this.locked.add(connection);
      }
    }
    clearTimeout(this.fallbacks.get(orgId));
    const fallback = setTimeout(() => { void this.refresh(orgId); }, 3000);
    fallback.unref();
    this.fallbacks.set(orgId, fallback);
  }

  private *sectionConnections(orgId: string): Generator<Connection<Context>> {
    for (const [connection] of this.connections(orgId)) {
      if (connection.context.target.kind === 'section') yield connection;
    }
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
    clearTimeout(this.fallbacks.get(orgId));
    this.fallbacks.delete(orgId);
    for (const [room, document] of this.hocuspocus.documents) {
      if (this.orgOf.get(room) !== orgId) continue;
      for (const connection of document.getConnections() as Connection<Context>[]) {
        const { context } = connection;
        const access = await withTenant(this.db, orgId, async (trx) => {
          const principal = await loadPrincipal(trx, { kind: 'user', id: context.userId, orgId });
          if (principal?.kind === 'user') context.clearance = principal.clearance;
          return principal ? this.accessFor(trx, principal, context.target) : 'none';
        });
        const wasLocked = this.locked.delete(connection);
        if (access === 'none') {
          connection.sendStateless(JSON.stringify({ type: 'access', access }));
          connection.close({ code: 4403, reason: 'Access revoked' });
          continue;
        }
        if (context.target.kind !== 'section') {
          connection.sendStateless(JSON.stringify({ type: 'refresh' }));
        } else {
          connection.readOnly = access !== 'edit';
          // Updates sent during the lock were refused, and clients don't resend on their own. Asking
          // for a sync makes the client send whatever the server is missing: nothing is lost.
          if (wasLocked && access === 'edit') {
            connection.send(new OutgoingMessage(connection.messageAddress).createSyncMessage().writeFirstSyncStepFor(document).toUint8Array());
          }
        }
        if (access !== context.access) {
          context.access = access;
          connection.sendStateless(JSON.stringify({ type: 'access', access }));
        }
      }
    }
  }
}
