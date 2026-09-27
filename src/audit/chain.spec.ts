import fc from 'fast-check';
import { type AuditContent, eventHash, genesisHash, type StoredEvent, verifyChain } from './chain';

const ORG = '5d4c3b2a-0000-4000-8000-000000000000';

function build(count: number): StoredEvent[] {
  const events: StoredEvent[] = [];
  let prev = genesisHash(ORG);
  for (let seq = 1; seq <= count; seq += 1) {
    const content: AuditContent = {
      seq, at: new Date(1_700_000_000_000 + seq * 1000).toISOString(), actorType: 'user', actorId: null,
      action: 'document.update', resourceType: 'document', resourceId: null, detail: { n: seq, tags: ['a', 'b'] },
    };
    const hash = eventHash(prev, content);
    events.push({ ...content, prevHash: prev, hash });
    prev = hash;
  }
  return events;
}

test('an untouched chain verifies, including an empty one', () => {
  expect(verifyChain(ORG, [])).toEqual({ ok: true, events: 0 });
  expect(verifyChain(ORG, build(5))).toEqual({ ok: true, events: 5 });
});

test('a chain for one organization does not verify as another', () => {
  expect(verifyChain('another-org', build(2))).toMatchObject({ ok: false, brokenAt: 1 });
});

test('a gap is caught even if the attacker recomputed every hash', () => {
  const events = build(3);
  // Drop event 2 and re-link event 3 onto event 1 with a freshly computed hash.
  const { prevHash: _p, hash: _h, ...third } = events[2]!;
  const relinked = { ...third, prevHash: events[0]!.hash, hash: eventHash(events[0]!.hash, third) };
  expect(verifyChain(ORG, [events[0]!, relinked])).toEqual({ ok: false, events: 2, brokenAt: 3, reason: 'expected event 2' });
});

test('each kind of break is reported with its reason', () => {
  const edited = build(2);
  edited[1] = { ...edited[1]!, action: 'forged' };
  expect(verifyChain(ORG, edited)).toMatchObject({ reason: 'content does not match its hash', brokenAt: 2 });
  const relinked = build(2);
  relinked[1] = { ...relinked[1]!, prevHash: 'f'.repeat(64) };
  expect(verifyChain(ORG, relinked)).toMatchObject({ reason: 'does not link to the previous event', brokenAt: 2 });
});

test('key order in the detail does not change the hash', () => {
  const [event] = build(1);
  const { prevHash, hash, ...content } = event!;
  expect(eventHash(prevHash, { ...content, detail: { tags: ['a', 'b'], n: 1 } })).toBe(hash);
});

test('any single edit, deletion or swap is caught at the first affected event', () => {
  fc.assert(fc.property(fc.integer({ min: 2, max: 12 }), fc.nat(), fc.constantFrom('edit', 'delete', 'swap', 'relink'), (count, pick, kind) => {
    const events = build(count);
    const i = pick % (count - 1);
    if (kind === 'edit') events[i] = { ...events[i]!, action: 'something.else' };
    if (kind === 'delete') events.splice(i, 1);
    if (kind === 'swap') [events[i], events[i + 1]] = [events[i + 1]!, events[i]!];
    if (kind === 'relink') events[i + 1] = { ...events[i + 1]!, prevHash: 'f'.repeat(64) };
    const check = verifyChain(ORG, events);
    expect(check.ok).toBe(false);
    // brokenAt is the stored sequence number of the first event that no longer fits.
    if (!check.ok) expect(check.brokenAt).toBe(kind === 'edit' ? i + 1 : i + 2);
  }));
});
