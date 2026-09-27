import * as Y from 'yjs';

/*
 * Word-level classification ("mark to classify, project to read", docs/COLLABORATION.md).
 *
 * In a section's full text, classified words carry the editor mark `classified: { level }`, which
 * the TipTap/Yjs binding stores as a formatting attribute on the text. Readers not cleared for
 * every mark get a projection: a separate, server-written document with the same paragraphs, where
 * each run of words above their clearance is replaced by a bar (`redaction` mark) of rounded
 * length. Projections are rebuilt from the full text; nothing hidden is ever copied into them.
 */

export const MARK = 'classified';
export const REDACTION = 'redaction';
export const FRAGMENT = 'default'; // the XML fragment TipTap's Collaboration extension uses

type Attributes = Record<string, unknown> | undefined;
interface DeltaOp { insert: unknown; attributes?: Attributes }

export function markLevel(attributes: Attributes): number {
  const mark = attributes?.[MARK] as { level?: unknown } | undefined;
  const level = Number(mark?.level ?? 0);
  return Number.isInteger(level) && level > 0 ? level : 0;
}

/** The highest classification marked anywhere in a fragment (0 if none). */
export function maxMarkLevel(node: Y.XmlFragment | Y.XmlElement | Y.XmlText): number {
  if (node instanceof Y.XmlText) {
    return (node.toDelta() as DeltaOp[]).reduce((max, op) => Math.max(max, markLevel(op.attributes)), 0);
  }
  return node.toArray().reduce((max, child) => (child instanceof Y.XmlHook ? max : Math.max(max, maxMarkLevel(child))), 0);
}

/** Bars are rounded up to multiples of 6 characters: roughly how much is hidden, never exactly. */
export const barLength = (length: number): number => Math.max(6, Math.ceil(length / 6) * 6);

/** A text run as a reader at `level` may see it: runs above it become bars, adjacent bars merge. */
export function projectDelta(delta: DeltaOp[], level: number): DeltaOp[] {
  const out: DeltaOp[] = [];
  let hidden = 0;
  const flush = () => {
    if (hidden > 0) out.push({ insert: '█'.repeat(barLength(hidden)), attributes: { [REDACTION]: {} } });
    hidden = 0;
  };
  for (const op of delta) {
    if (typeof op.insert !== 'string') continue; // embeds carry no text we support
    if (markLevel(op.attributes) > level) {
      hidden += op.insert.length;
    } else {
      flush();
      out.push(op.attributes ? { insert: op.insert, attributes: op.attributes } : { insert: op.insert });
    }
  }
  flush();
  return out;
}

type Node = Y.XmlElement | Y.XmlText;

/** Replaces `target`'s content with `source` as seen at `level`. Call inside a transaction. */
export function project(source: Y.XmlFragment, target: Y.XmlFragment, level: number): void {
  const texts: [Y.XmlText, DeltaOp[]][] = [];
  const copy = (node: Y.XmlElement | Y.XmlText | Y.XmlHook): Node | null => {
    if (node instanceof Y.XmlText) {
      const text = new Y.XmlText();
      texts.push([text, projectDelta(node.toDelta() as DeltaOp[], level)]);
      return text;
    }
    if (node instanceof Y.XmlElement) {
      const element = new Y.XmlElement(node.nodeName);
      for (const [key, value] of Object.entries(node.getAttributes())) element.setAttribute(key, value as string);
      element.insert(0, node.toArray().map(copy).filter((n): n is Node => n !== null));
      return element;
    }
    return null;
  };
  if (target.length) target.delete(0, target.length);
  target.insert(0, source.toArray().map(copy).filter((n): n is Node => n !== null));
  // Text can only be filled once it's part of the document.
  for (const [text, delta] of texts) text.applyDelta(delta);
}
