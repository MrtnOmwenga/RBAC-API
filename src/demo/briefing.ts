import * as Y from 'yjs';

/** A run of text, optionally marked with a classification above its section's (word-level). */
type Run = string | [text: string, level: number];

/** The demo briefing. Entirely fictional. */
export const NIGHTJAR: { title: string; sections: { heading: string; classification: number; text: Run[][] }[] } = {
  title: 'Operation NIGHTJAR: mission briefing',
  sections: [
    {
      heading: 'Cover story',
      classification: 0,
      text: [
        ['Our team attends the Lisbon Maritime Trade Fair as logistics consultants.'],
        ['Travel and hotels are booked through the usual front company, ', ['Atlas Freight Lda', 1], '.'],
      ],
    },
    {
      heading: 'Contacts',
      classification: 1,
      text: [
        ['Courier ', ['MERIDIAN', 2], ' waits at the Mercado da Ribeira fish market on Thursday at 07:30.'],
        ['Recognition phrase: "The sardines are early this year."'],
      ],
    },
    {
      heading: 'The asset',
      classification: 2,
      text: [
        ['NIGHTJAR is the ', ['deputy minister of ports', 3], '.'],
        ['She will hand over the shipping manifests in exchange for safe passage for her family.'],
      ],
    },
    {
      heading: 'Exfiltration',
      classification: 3,
      text: [
        ['If the operation is compromised: submarine pickup off Cabo da Roca at 03:00.'],
        ['Signal with three short flashes, then wait for two long ones.'],
      ],
    },
  ],
};

/**
 * A Yjs document shaped like the editor's: paragraphs in the `default` fragment, classified words
 * carrying the `classified` mark the editor uses. Returns the highest level marked, too.
 */
export function sectionState(paragraphs: Run[][]): { state: Buffer; length: number; marked: number } {
  const doc = new Y.Doc();
  const texts: [Y.XmlText, Run[]][] = [];
  doc.transact(() => {
    for (const runs of paragraphs) {
      const paragraph = new Y.XmlElement('paragraph');
      const text = new Y.XmlText();
      paragraph.insert(0, [text]);
      doc.getXmlFragment('default').push([paragraph]);
      texts.push([text, runs]);
    }
    for (const [text, runs] of texts) {
      text.applyDelta(runs.map((run) => (typeof run === 'string' ? { insert: run } : { insert: run[0], attributes: { classified: { level: run[1] } } })));
    }
  });
  const flat = paragraphs.flat();
  return {
    state: Buffer.from(Y.encodeStateAsUpdate(doc)),
    length: flat.reduce((n, run) => n + (typeof run === 'string' ? run : run[0]).length, 0),
    marked: flat.reduce((max, run) => (typeof run === 'string' ? max : Math.max(max, run[1])), 0),
  };
}
