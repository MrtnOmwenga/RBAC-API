import { createPrivateKey, createPublicKey, hkdfSync, type KeyObject, sign, verify } from 'node:crypto';
import { canonicalJson } from '../common/crypto';
import { genesisHash, type StoredEvent } from './chain';

/*
 * The chain shows a change to part of the log. It can't show the two things a database owner can
 * still do: rewrite every event from some point on and recompute the hashes, or cut off the newest
 * events. Either leaves a chain that verifies, because nothing outside the database remembers how
 * it ended.
 *
 * A checkpoint is that memory: "this organization's log had N events and ended in hash H at time
 * T", signed by the service with a key the database doesn't hold. Kept anywhere outside the
 * database (an auditor's files, the service's own log stream), it is later checked against the
 * chain: event N must still exist, and still have hash H.
 */

export interface Checkpoint {
  orgId: string;
  seq: number;
  hash: string;
  at: string;
  signature: string;
}

export type CheckpointCheck = { ok: true } | { ok: false; reason: string };

const PKCS8_ED25519 = Buffer.from('302e020100300506032b657004220420', 'hex');

/** The signing key, derived from the service's secret so that it exists wherever the service runs. */
export function checkpointKey(secret: string): { privateKey: KeyObject; publicKey: string } {
  const seed = Buffer.from(hkdfSync('sha256', secret, Buffer.alloc(0), 'rbac-api/audit-checkpoint', 32));
  const privateKey = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519, seed]), format: 'der', type: 'pkcs8' });
  const publicKey = createPublicKey(privateKey).export({ format: 'jwk' }).x!;
  return { privateKey, publicKey };
}

const statement = (c: Omit<Checkpoint, 'signature'>): Buffer => Buffer.from(canonicalJson({ orgId: c.orgId, seq: c.seq, hash: c.hash, at: c.at }));

export function signCheckpoint(privateKey: KeyObject, orgId: string, last: { seq: number; hash: string } | undefined, at: Date): Checkpoint {
  const body = { orgId, seq: last?.seq ?? 0, hash: last?.hash ?? genesisHash(orgId), at: at.toISOString() };
  return { ...body, signature: sign(null, statement(body), privateKey).toString('base64url') };
}

/**
 * Whether the log as it is now still agrees with a checkpoint taken earlier. `event` is the stored
 * event with the checkpoint's sequence number, if there still is one.
 */
export function checkAgainst(privateKey: KeyObject, orgId: string, checkpoint: Checkpoint, event: Pick<StoredEvent, 'hash'> | undefined): CheckpointCheck {
  const signed = (() => {
    try {
      return verify(null, statement(checkpoint), createPublicKey(privateKey), Buffer.from(checkpoint.signature, 'base64url'));
    } catch {
      return false;
    }
  })();
  if (!signed) return { ok: false, reason: 'the checkpoint was not signed by this service, or was altered' };
  if (checkpoint.orgId !== orgId) return { ok: false, reason: 'the checkpoint is for another organization' };
  if (checkpoint.seq === 0) return checkpoint.hash === genesisHash(orgId) ? { ok: true } : { ok: false, reason: 'the checkpoint does not start this organization\'s log' };
  if (!event) return { ok: false, reason: `the log no longer has event ${checkpoint.seq}: its newest events were removed` };
  if (event.hash !== checkpoint.hash) return { ok: false, reason: `event ${checkpoint.seq} is not the one the checkpoint saw: the log was rewritten` };
  return { ok: true };
}
