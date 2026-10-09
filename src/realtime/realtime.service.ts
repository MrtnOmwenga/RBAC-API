import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { type Connection, Hocuspocus, OutgoingMessage } from '@hocuspocus/server';
import { type Kysely, sql, type Transaction } from 'kysely';
import { Client } from 'pg';
import { createDecoder, readVarString, readVarUint, readVarUint8Array } from 'lib0/decoding';
import { WebSocketServer } from 'ws';
import * as Y from 'yjs';
import { AuditService } from '../audit/audit.service';
import { SESSION_CHANNEL } from '../auth/auth.service';
import { loadPrincipal } from '../auth/authentication';
import { verifyAccessToken } from '../auth/tokens';
import { ACCESS_CHANNEL, loadDocumentAccess } from '../briefings/access';
import { fromEdge } from '../common/edge';
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

/** How far a permission change reaches: one member's access, or one document's. */
export type Scope = { member: string } | { document: string };

function readScope(payload: string): { orgId: string; scope?: Scope } {
  const [orgId = '', kind, id] = payload.split(' ');
  if (kind === 'member' && id) return { orgId, scope: { member: id } };
  if (kind === 'document' && id) return { orgId, scope: { document: id } };
  return { orgId };
}

type Target = { kind: 'section' | 'briefing' | 'member'; id: string } | { kind: 'projection'; id: string; level: number };
interface Context {
  userId: string;
  orgId: string;
  target: Target;
  /** The document a section, projection or briefing connection belongs to. */
  documentId?: string;
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
const READ_RECORDED_EVERY_MS = 15 * 60_000;
const SECTION_CHANNEL = 'rbac_section_sync';
const FROM_ANOTHER_INSTANCE = 'another-instance'; // the origin of updates that didn't start here
const MAX_NOTIFICATION = 7500; // PostgreSQL refuses a NOTIFY payload of 8000 bytes or more
const EMPTY_UPDATE = 2; // an update that says nothing is two bytes
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

/** Whether a change of this scope could alter what this connection may do. */
function within(context: Context, scope?: Scope): boolean {
  if (!scope) return true;
  return 'member' in scope ? context.userId === scope.member : context.documentId === scope.document;
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
  private readonly reads = new Map<string, number>(); // member + section + view → when its read was last recorded
  private readonly instance = randomUUID(); // tells this instance's own messages from the others'
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
      onChange: async ({ documentName, document, context, update, transactionOrigin }) => {
        if (context?.userId) {
          const set = this.editors.get(documentName) ?? new Set<string>();
          set.add(context.userId);
          this.editors.set(documentName, set);
        }
        const target = parseRoom(documentName);
        if (target?.kind === 'section') {
          this.scheduleProjection(target.id);
          // An edit made here goes to the other instances; one that came from them stops here.
          if (transactionOrigin !== FROM_ANOTHER_INSTANCE) void this.publish(documentName, document, { u: Buffer.from(update).toString('base64') });
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
      if (!req.url?.startsWith('/collab') || !fromEdge(this.config, req.headers)) {
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
      if (msg.channel === SESSION_CHANNEL) {
        this.endSession(msg.payload);
      } else if (msg.channel === SECTION_CHANNEL) {
        void this.receive(msg.payload).catch((err: unknown) => this.logger.warn(`section sync failed: ${err instanceof Error ? err.message : String(err)}`));
      } else {
        const { orgId, scope } = readScope(msg.payload);
        void this.refresh(orgId, scope);
      }
    });
    client.on('error', (err) => {
      this.logger.warn(`permission listener lost: ${err.message}`);
      if (!this.closing) setTimeout(() => { void this.listen(); }, 1000);
    });
    await client.connect();
    await client.query(`LISTEN ${ACCESS_CHANNEL}; LISTEN ${SESSION_CHANNEL}; LISTEN ${SECTION_CHANNEL}`);
    this.listener = client;
  }

  private async authenticate(token: string, room: string, connectionConfig: { readOnly: boolean }): Promise<Context> {
    const claims = verifyAccessToken(this.config.JWT_SECRET, token);
    const target = parseRoom(room);
    if (!claims || !target) throw new Error('unauthorized');
    const { access, clearance, documentId } = await withTenant(this.db, claims.orgId, async (trx) => {
      const principal = await loadPrincipal(trx, { kind: 'user', id: claims.userId, orgId: claims.orgId });
      return {
        access: principal ? await this.accessFor(trx, principal, target) : 'none',
        clearance: principal?.kind === 'user' ? principal.clearance : 0,
        documentId: await this.documentOf(trx, target),
      };
    });
    if (access === 'none') throw new Error('forbidden');
    if (target.kind === 'section' || target.kind === 'projection') await this.noteRead(claims.orgId, claims.userId, target);
    connectionConfig.readOnly = target.kind !== 'section' || access !== 'edit';
    this.orgOf.set(room, claims.orgId);
    return {
      userId: claims.userId, orgId: claims.orgId, target, access, clearance, ...(documentId ? { documentId } : {}),
      ...(claims.sessionId ? { sessionId: claims.sessionId } : {}), expiresAt: claims.expiresAt.getTime(),
    };
  }

  /**
   * Opening a classified section is recorded: the log says who changed it, and an investigation
   * asks who read it. A page opens a section's connection once and reconnects now and then, so one
   * event is written per member, section and view each quarter of an hour, not per connection.
   */
  private async noteRead(orgId: string, userId: string, target: Target): Promise<void> {
    const key = `${userId}:${target.kind}:${target.id}${target.kind === 'projection' ? `:${target.level}` : ''}`;
    const now = Date.now();
    if (now - (this.reads.get(key) ?? 0) < READ_RECORDED_EVERY_MS) return;
    await withTenant(this.db, orgId, async (trx) => {
      const section = await trx.selectFrom('document_sections').select(['document_id', 'classification', 'max_mark_level'])
        .where('id', '=', target.id).executeTakeFirst();
      if (!section) return;
      const marked = this.markedLevel(target.id, section.max_mark_level);
      if (section.classification === 0 && marked === 0) return; // nothing classified in it
      await this.audit.record(trx, orgId, { actorType: 'user', actorId: userId }, {
        action: 'section.read', resourceType: 'document', resourceId: section.document_id,
        detail: {
          section: target.id, classification: CLEARANCES[section.classification],
          // The full text, or the copy with words above this level barred out.
          ...(target.kind === 'projection' ? { view: 'projection', level: CLEARANCES[target.level] } : { view: 'full', markedUpTo: CLEARANCES[marked] }),
        },
      });
    });
    this.reads.set(key, now);
    if (this.reads.size > 10_000) for (const [k, at] of this.reads) if (now - at >= READ_RECORDED_EVERY_MS) this.reads.delete(k);
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
    // Every page showing this document re-fetches: some now read a projection.
    void this.refresh(context.orgId, context.documentId ? { document: context.documentId } : undefined);
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

  private async documentOf(trx: Transaction<Database>, target: Target): Promise<string | undefined> {
    if (target.kind === 'member') return undefined;
    if (target.kind === 'briefing') return target.id;
    return (await trx.selectFrom('document_sections').select('document_id').where('id', '=', target.id).executeTakeFirst())?.document_id;
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
    if (row?.state.length) Y.applyUpdate(document, new Uint8Array(row.state), FROM_ANOTHER_INSTANCE);
    // The database lags what another instance's editors have typed since its last save. Say what
    // this copy has; any instance with the section open answers with what is missing.
    void this.publish(room, document, { sv: Buffer.from(Y.encodeStateVector(document)).toString('base64') });
  }

  /*
   * Several instances. Each keeps its own copy of an open section in memory, so an edit accepted by
   * one has to reach the others: it is sent through PostgreSQL NOTIFY, which every instance already
   * listens on, and applied to their copies. Updates merge in any order (they are CRDT updates), so
   * nothing needs sequencing. Three kinds of message:
   *   u       an update to apply
   *   sv      "this is what I have" from an instance that just opened the section; whoever has
   *           more answers with the difference
   *   reload  the update was too big for a notification (8000 bytes): it has been saved, read it
   * Every edit was authorized by the instance that accepted it. What a receiving instance still
   * has to do itself is protect its own readers when words are classified above their clearance.
   */
  private async publish(room: string, document: Y.Doc, message: { u: string } | { sv: string }): Promise<void> {
    const orgId = this.orgOf.get(room);
    if (!orgId || this.closing) return;
    try {
      let payload = JSON.stringify({ i: this.instance, r: room, o: orgId, ...message });
      if (payload.length > MAX_NOTIFICATION) {
        await this.store(room, document);
        payload = JSON.stringify({ i: this.instance, r: room, o: orgId, reload: true });
      }
      await sql`select pg_notify(${SECTION_CHANNEL}, ${payload})`.execute(this.db);
    } catch (err) {
      this.logger.warn(`section sync failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async receive(payload: string): Promise<void> {
    const message = JSON.parse(payload) as { i: string; r: string; o: string; u?: string; sv?: string; reload?: boolean };
    if (message.i === this.instance) return;
    const document = this.hocuspocus.documents.get(message.r);
    const target = parseRoom(message.r);
    if (!document || target?.kind !== 'section') return; // not open here: nothing to keep in step
    if (message.sv) {
      const missing = Y.encodeStateAsUpdate(document, new Uint8Array(Buffer.from(message.sv, 'base64')));
      if (missing.length > EMPTY_UPDATE) await this.publish(message.r, document, { u: Buffer.from(missing).toString('base64') });
      return;
    }
    let update: Uint8Array;
    if (message.u) {
      update = new Uint8Array(Buffer.from(message.u, 'base64'));
    } else {
      const row = await withTenant(this.db, message.o, (trx) => trx.selectFrom('document_sections').select('state').where('id', '=', target.id).executeTakeFirst());
      if (!row?.state.length) return;
      update = new Uint8Array(row.state);
    }
    this.shield(document, update, message.o);
    Y.applyUpdate(document, update, FROM_ANOTHER_INSTANCE);
  }

  /**
   * Before an update from elsewhere is applied: if it marks words above the clearance of someone
   * connected to the full text here, they are disconnected first, so it never reaches them.
   */
  private shield(document: Y.Doc, update: Uint8Array, orgId: string): void {
    const probe = new Y.Doc();
    Y.applyUpdate(probe, Y.encodeStateAsUpdate(document));
    Y.applyUpdate(probe, update);
    const after = maxMarkLevel(probe.getXmlFragment(FRAGMENT));
    probe.destroy();
    if (after <= maxMarkLevel(document.getXmlFragment(FRAGMENT))) return;
    for (const other of (document as unknown as { getConnections(): Connection<Context>[] }).getConnections()) {
      if (other.context.clearance < after) {
        other.sendStateless(JSON.stringify({ type: 'access', access: 'none' }));
        other.close({ code: 4403, reason: 'Section now above your clearance' });
      }
    }
    void this.refresh(orgId); // pages here re-fetch: some now read a projection
  }

  /** Saves a section (debounced by Hocuspocus) and records who edited it since the last save. */
  private async store(room: string, document: Y.Doc): Promise<void> {
    const target = parseRoom(room);
    const orgId = this.orgOf.get(room);
    if (target?.kind !== 'section' || !orgId) return;
    const editors = [...(this.editors.get(room) ?? [])];
    this.editors.delete(room);
    await withTenant(this.db, orgId, async (trx) => {
      // What is stored may hold edits this copy never received (saved by another instance): they
      // are merged in before saving, so a save can only add to what is stored.
      const before = await trx.selectFrom('document_sections').select(['max_mark_level', 'state']).where('id', '=', target.id).forUpdate().executeTakeFirst();
      if (before?.state.length) {
        const stored = new Uint8Array(before.state);
        this.shield(document, stored, orgId);
        Y.applyUpdate(document, stored, FROM_ANOTHER_INSTANCE);
      }
      const marked = maxMarkLevel(document.getXmlFragment(FRAGMENT));
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
   * Fails closed: every section connection the change could affect turns read-only now, before the
   * permission change commits. The re-check that follows the notification restores the ones still
   * allowed to write. If the change rolls back there is no notification, so a fallback re-check
   * runs after a few seconds either way.
   */
  lock(orgId: string, scope?: Scope): void {
    for (const connection of this.sectionConnections(orgId)) {
      if (!connection.readOnly && within(connection.context, scope)) {
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
   * Re-checks the open connections a permission change could affect (all of the organization's,
   * with no scope). Runs are chained per organization so a burst of changes can't interleave.
   */
  refresh(orgId: string, scope?: Scope): Promise<void> {
    const previous = this.refreshing.get(orgId) ?? Promise.resolve();
    const run = previous.then(() => this.recheck(orgId, scope)).catch((err: unknown) => {
      this.logger.error(`re-checking access failed: ${err instanceof Error ? err.message : String(err)}`);
    });
    this.refreshing.set(orgId, run);
    void run.finally(() => { if (this.refreshing.get(orgId) === run) this.refreshing.delete(orgId); });
    return run;
  }

  private async recheck(orgId: string, scope?: Scope): Promise<void> {
    // The fallback is for a change that rolled back, so it re-checks everything; only a re-check
    // as wide makes it unnecessary.
    if (!scope) {
      clearTimeout(this.fallbacks.get(orgId));
      this.fallbacks.delete(orgId);
    }
    for (const [room, document] of this.hocuspocus.documents) {
      if (this.orgOf.get(room) !== orgId) continue;
      for (const connection of document.getConnections() as Connection<Context>[]) {
        const { context } = connection;
        // Text connections outside the change's reach are left as they are. The channels that only
        // tell a page to re-fetch are always told: a member with no access yet may just have got some.
        const carriesText = context.target.kind === 'section' || context.target.kind === 'projection';
        if (carriesText && !within(context, scope)) continue;
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
