import { canonicalJson, sha256 } from '../common/crypto';

/*
 * The audit log is a hash chain per organization: each event's hash covers its content and the
 * previous event's hash. Editing, deleting or reordering any stored event breaks every hash after
 * it, which `verifyChain` reports. (The database also refuses UPDATE and DELETE to the API's role;
 * the chain catches changes made around the API, e.g. by someone with owner access.)
 */

export interface AuditContent {
  seq: number;
  at: string;
  actorType: 'user' | 'integration' | 'anonymous';
  actorId: string | null;
  action: string;
  resourceType: string;
  resourceId: string | null;
  detail: Record<string, unknown>;
}

export const genesisHash = (orgId: string): string => sha256(`rbac-api/audit/${orgId}`);

export const eventHash = (prevHash: string, content: AuditContent): string => sha256(`${prevHash}\n${canonicalJson(content)}`);

export interface StoredEvent extends AuditContent {
  prevHash: string;
  hash: string;
}

export type ChainCheck = { ok: true; events: number } | { ok: false; events: number; brokenAt: number; reason: string };

/** Checks events (in seq order) link from the genesis hash with no gaps and no altered content. */
export function verifyChain(orgId: string, events: readonly StoredEvent[]): ChainCheck {
  let prev = genesisHash(orgId);
  for (const [i, event] of events.entries()) {
    const { prevHash, hash, ...content } = event;
    if (event.seq !== i + 1) return { ok: false, events: events.length, brokenAt: event.seq, reason: `expected event ${i + 1}` };
    if (prevHash !== prev) return { ok: false, events: events.length, brokenAt: event.seq, reason: 'does not link to the previous event' };
    if (eventHash(prevHash, content) !== hash) return { ok: false, events: events.length, brokenAt: event.seq, reason: 'content does not match its hash' };
    prev = hash;
  }
  return { ok: true, events: events.length };
}
