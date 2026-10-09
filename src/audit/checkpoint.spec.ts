import { genesisHash } from './chain';
import { checkAgainst, checkpointKey, signCheckpoint } from './checkpoint';

const ORG = '11111111-1111-4111-8111-111111111111';
const { privateKey, publicKey } = checkpointKey('s'.repeat(32));
const at = new Date('2026-10-09T10:00:00Z');
const last = { seq: 7, hash: 'a'.repeat(64) };

test('the key is the same wherever the service has the same secret, and differs with it', () => {
  expect(checkpointKey('s'.repeat(32)).publicKey).toBe(publicKey);
  expect(checkpointKey('t'.repeat(32)).publicKey).not.toBe(publicKey);
  expect(publicKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
});

test('a checkpoint agrees with the log it was taken from', () => {
  const checkpoint = signCheckpoint(privateKey, ORG, last, at);
  expect(checkpoint).toMatchObject({ orgId: ORG, seq: 7, hash: last.hash, at: '2026-10-09T10:00:00.000Z' });
  expect(checkAgainst(privateKey, ORG, checkpoint, { hash: last.hash })).toEqual({ ok: true });
});

test('an empty log has a checkpoint too, at its starting hash', () => {
  const checkpoint = signCheckpoint(privateKey, ORG, undefined, at);
  expect(checkpoint).toMatchObject({ seq: 0, hash: genesisHash(ORG) });
  expect(checkAgainst(privateKey, ORG, checkpoint, undefined)).toEqual({ ok: true });
});

test('newest events removed, or the log rewritten, no longer agree', () => {
  const checkpoint = signCheckpoint(privateKey, ORG, last, at);
  expect(checkAgainst(privateKey, ORG, checkpoint, undefined)).toEqual({ ok: false, reason: 'the log no longer has event 7: its newest events were removed' });
  expect(checkAgainst(privateKey, ORG, checkpoint, { hash: 'b'.repeat(64) })).toEqual({ ok: false, reason: 'event 7 is not the one the checkpoint saw: the log was rewritten' });
});

test('a checkpoint that was edited, made by another key, or belongs to another organization is refused', () => {
  const checkpoint = signCheckpoint(privateKey, ORG, last, at);
  const refused = { ok: false, reason: 'the checkpoint was not signed by this service, or was altered' };
  expect(checkAgainst(privateKey, ORG, { ...checkpoint, seq: 3 }, { hash: last.hash })).toEqual(refused);
  expect(checkAgainst(privateKey, ORG, { ...checkpoint, hash: 'b'.repeat(64) }, { hash: 'b'.repeat(64) })).toEqual(refused);
  expect(checkAgainst(privateKey, ORG, { ...checkpoint, signature: 'not a signature' }, { hash: last.hash })).toEqual(refused);
  const other = signCheckpoint(checkpointKey('t'.repeat(32)).privateKey, ORG, last, at);
  expect(checkAgainst(privateKey, ORG, other, { hash: last.hash })).toEqual(refused);
  const theirs = signCheckpoint(privateKey, '22222222-2222-4222-8222-222222222222', last, at);
  expect(checkAgainst(privateKey, ORG, theirs, { hash: last.hash })).toEqual({ ok: false, reason: 'the checkpoint is for another organization' });
});
