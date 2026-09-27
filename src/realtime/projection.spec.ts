import fc from 'fast-check';
import * as Y from 'yjs';
import { barLength, FRAGMENT, maxMarkLevel, project, projectDelta } from './projection';

/** A section of paragraphs, each a list of [text, level] runs (level 0 = unmarked). */
function section(paragraphs: [string, number][][]): Y.Doc {
  const doc = new Y.Doc();
  doc.transact(() => {
    const fragment = doc.getXmlFragment(FRAGMENT);
    const texts: [Y.XmlText, [string, number][]][] = [];
    for (const runs of paragraphs) {
      const p = new Y.XmlElement('paragraph');
      const text = new Y.XmlText();
      p.insert(0, [text]);
      fragment.push([p]);
      texts.push([text, runs]);
    }
    for (const [text, runs] of texts) {
      text.applyDelta(runs.map(([insert, level]) => (level ? { insert, attributes: { classified: { level } } } : { insert })));
    }
  });
  return doc;
}

const projected = (doc: Y.Doc, level: number): Y.Doc => {
  const out = new Y.Doc();
  out.transact(() => project(doc.getXmlFragment(FRAGMENT), out.getXmlFragment(FRAGMENT), level));
  return out;
};
const plain = (doc: Y.Doc) => doc.getXmlFragment(FRAGMENT).toArray()
  .map((p) => (((p as Y.XmlElement).toArray()[0] as Y.XmlText).toDelta() as { insert: string }[]).map((d) => d.insert).join('')).join('\n');

test('words above the reader\'s level become bars; the rest, and the paragraph structure, stay', () => {
  const doc = section([
    [['Courier ', 0], ['MERIDIAN', 2], [' waits at the market.', 0]],
    [['Pickup by ', 0], ['submarine', 3], ['.', 0]],
  ]);
  expect(maxMarkLevel(doc.getXmlFragment(FRAGMENT))).toBe(3);
  expect(plain(projected(doc, 1))).toBe('Courier ████████████ waits at the market.\nPickup by ████████████.');
  expect(plain(projected(doc, 2))).toBe('Courier MERIDIAN waits at the market.\nPickup by ████████████.');
  expect(plain(projected(doc, 3))).toBe(plain(doc));
});

test('adjacent hidden runs merge into one bar, and bars round up to multiples of six', () => {
  expect(projectDelta([{ insert: 'ab', attributes: { classified: { level: 2 } } }, { insert: 'cd', attributes: { classified: { level: 3 } } }], 1))
    .toEqual([{ insert: '██████', attributes: { redaction: {} } }]);
  expect([1, 6, 7, 12, 13].map(barLength)).toEqual([6, 6, 12, 12, 18]);
});

test('projecting again replaces the previous projection', () => {
  const doc = section([[['secret', 2]]]);
  const out = projected(doc, 0);
  out.transact(() => project(section([[['open', 0]]]).getXmlFragment(FRAGMENT), out.getXmlFragment(FRAGMENT), 0));
  expect(plain(out)).toBe('open');
});

test('no projection ever contains a character of a run above its level', () => {
  const run = fc.tuple(fc.stringMatching(/^[a-z]{1,8}$/), fc.integer({ min: 0, max: 3 }));
  fc.assert(fc.property(fc.array(fc.array(run, { minLength: 1, maxLength: 5 }), { minLength: 1, maxLength: 4 }), fc.integer({ min: 0, max: 3 }), (paragraphs, level) => {
    // Make hidden words distinctive so a leak can't hide inside visible text.
    const marked = paragraphs.map((runs) => runs.map(([t, l]): [string, number] => [l > level ? `X${t.toUpperCase()}X` : t, l]));
    const out = plain(projected(section(marked), level));
    for (const runs of marked) for (const [t, l] of runs) if (l > level) expect(out).not.toContain(t);
    expect(out.split('\n')).toHaveLength(marked.length);
  }), { numRuns: 500 });
});

