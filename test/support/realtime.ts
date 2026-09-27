import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider';
import WebSocket from 'ws';
import * as Y from 'yjs';
import type { Actor } from './world';

export interface Client {
  doc: Y.Doc;
  provider: HocuspocusProvider;
  stateless: unknown[];
  closeCodes: number[];
  authFailed: boolean;
  /** Resolves once the client has synced, or rejects if the server refused it. */
  ready: Promise<void>;
  destroy: () => void;
}

const tokenOf = (actor: Actor) => actor.headers.authorization!.slice('Bearer '.length);

/** A Node.js collaboration client for `room`, authenticated as `actor`. */
export function connect(baseUrl: string, actor: Actor, room: string): Client {
  const doc = new Y.Doc();
  const client: Partial<Client> = { doc, stateless: [], closeCodes: [], authFailed: false };
  const socket = new HocuspocusProviderWebsocket({
    url: `${baseUrl.replace(/^http/, 'ws')}/collab`, WebSocketPolyfill: WebSocket, maxAttempts: 1,
  });
  client.ready = new Promise<void>((resolve, reject) => {
    client.provider = new HocuspocusProvider({
      websocketProvider: socket,
      name: room,
      document: doc,
      token: tokenOf(actor),
      onSynced: () => resolve(),
      onAuthenticationFailed: ({ reason }) => { client.authFailed = true; reject(new Error(reason)); },
      onStateless: ({ payload }) => { client.stateless!.push(JSON.parse(payload)); },
      onClose: ({ event }) => { client.closeCodes!.push(event.code); },
    });
    // With a socket passed in, the provider doesn't attach itself.
    client.provider.attach();
  });
  client.destroy = () => { client.provider!.destroy(); socket.destroy(); };
  return client as Client;
}

/** Appends a paragraph the way the TipTap editor would. */
export function type(doc: Y.Doc, text: string): void {
  const paragraph = new Y.XmlElement('paragraph');
  paragraph.insert(0, [new Y.XmlText(text)]);
  doc.getXmlFragment('default').push([paragraph]);
}

/** The text of each paragraph, joined by newlines (formatting such as classification marks ignored). */
export const plainText = (doc: Y.Doc): string => doc.getXmlFragment('default').toArray()
  .map((p) => (p instanceof Y.XmlElement ? p.toArray().map((t) => (t instanceof Y.XmlText
    ? (t.toDelta() as { insert: unknown }[]).map((d) => (typeof d.insert === 'string' ? d.insert : '')).join('') : '')).join('') : ''))
  .join('\n');

/** Classifies every occurrence of `words`, the way the editor's mark does. */
export function mark(doc: Y.Doc, words: string, level: number): void {
  doc.transact(() => {
    for (const p of doc.getXmlFragment('default').toArray()) {
      if (!(p instanceof Y.XmlElement)) continue;
      for (const t of p.toArray()) {
        if (!(t instanceof Y.XmlText)) continue;
        const text = (t.toDelta() as { insert: unknown }[]).map((d) => (typeof d.insert === 'string' ? d.insert : '')).join('');
        const at = text.indexOf(words);
        if (at >= 0) t.format(at, words.length, { classified: { level } });
      }
    }
  });
}

/** Types `text` at the end of the first paragraph containing `after`, carrying a classification. */
export function typeClassified(doc: Y.Doc, after: string, text: string, level: number): void {
  for (const p of doc.getXmlFragment('default').toArray()) {
    const t = p instanceof Y.XmlElement ? p.toArray()[0] : undefined;
    if (t instanceof Y.XmlText && plainText(doc).includes(after)) {
      t.insert(t.length, text, { classified: { level } });
      return;
    }
  }
}

/** A section's stored state: paragraphs of [text, level] runs (level 0 = unmarked). */
export function sectionWithMarks(paragraphs: [string, number][][]): { state: Buffer; length: number; marked: number } {
  const doc = new Y.Doc();
  doc.transact(() => {
    const texts: [Y.XmlText, [string, number][]][] = [];
    for (const runs of paragraphs) {
      const p = new Y.XmlElement('paragraph');
      const t = new Y.XmlText();
      p.insert(0, [t]);
      doc.getXmlFragment('default').push([p]);
      texts.push([t, runs]);
    }
    for (const [t, runs] of texts) t.applyDelta(runs.map(([insert, level]) => (level ? { insert, attributes: { classified: { level } } } : { insert })));
  });
  const all = paragraphs.flat();
  return {
    state: Buffer.from(Y.encodeStateAsUpdate(doc)),
    length: all.reduce((n, [t]) => n + t.length, 0),
    marked: all.reduce((m, [, l]) => Math.max(m, l), 0),
  };
}

/** Everything a client's copy of a document holds, as text: for checking what was (not) received. */
export const everythingIn = (doc: Y.Doc): string => Buffer.from(Y.encodeStateAsUpdate(doc)).toString('utf8');

/** Polls until `check` passes (or fails after `timeoutMs`), for effects that arrive asynchronously. */
export async function eventually(check: () => void | Promise<void>, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await check();
      return;
    } catch (err) {
      if (Date.now() > deadline) throw err;
      await new Promise((r) => { setTimeout(r, 50); });
    }
  }
}
