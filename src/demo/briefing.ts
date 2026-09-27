import * as Y from 'yjs';

/** The demo briefing. Entirely fictional. */
export const NIGHTJAR = {
  title: 'Operation NIGHTJAR: mission briefing',
  sections: [
    {
      heading: 'Cover story',
      classification: 0,
      text: ['Our team attends the Lisbon Maritime Trade Fair as logistics consultants.', 'Travel and hotels are booked through the usual front company.'],
    },
    {
      heading: 'Contacts',
      classification: 1,
      text: ['Courier MERIDIAN waits at the Mercado da Ribeira fish market on Thursday at 07:30.', 'Recognition phrase: "The sardines are early this year."'],
    },
    {
      heading: 'The asset',
      classification: 2,
      text: ['NIGHTJAR is the deputy minister of ports.', 'She will hand over the shipping manifests in exchange for safe passage for her family.'],
    },
    {
      heading: 'Exfiltration',
      classification: 3,
      text: ['If the operation is compromised: submarine pickup off Cabo da Roca at 03:00.', 'Signal with three short flashes, then wait for two long ones.'],
    },
  ],
};

/** A Yjs document shaped like the editor's (paragraphs in the `default` fragment). */
export function sectionState(paragraphs: string[]): { state: Buffer; length: number } {
  const doc = new Y.Doc();
  const fragment = doc.getXmlFragment('default');
  for (const text of paragraphs) {
    const paragraph = new Y.XmlElement('paragraph');
    paragraph.insert(0, [new Y.XmlText(text)]);
    fragment.push([paragraph]);
  }
  return { state: Buffer.from(Y.encodeStateAsUpdate(doc)), length: paragraphs.join('').length };
}
