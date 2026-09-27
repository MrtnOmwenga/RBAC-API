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

export const plainText = (doc: Y.Doc): string => doc.getXmlFragment('default').toArray()
  .map((p) => (p instanceof Y.XmlElement ? p.toArray().map((t) => (t instanceof Y.XmlText ? t.toString() : '')).join('') : '')).join('\n');

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
