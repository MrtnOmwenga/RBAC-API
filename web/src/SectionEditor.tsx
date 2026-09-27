import { type HocuspocusProviderWebsocket, HocuspocusProvider } from '@hocuspocus/provider';
import Collaboration from '@tiptap/extension-collaboration';
import CollaborationCaret from '@tiptap/extension-collaboration-caret';
import { EditorContent, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { useEffect, useMemo, useState } from 'react';
import * as Y from 'yjs';
import type { Access } from './api';

interface Props {
  sectionId: string;
  access: Access;
  socket: HocuspocusProviderWebsocket;
  token: string;
  user: { name: string; color: string };
}

/**
 * One section's live text. The server decides whether this connection may write: a read-only
 * connection's edits are dropped there, and `editable` here just keeps the UI honest about it.
 */
export function SectionEditor({ sectionId, access, socket, token, user }: Props) {
  const [live, setLive] = useState<Access>(access);
  const doc = useMemo(() => new Y.Doc(), [sectionId]);
  const provider = useMemo(() => {
    const p = new HocuspocusProvider({
      websocketProvider: socket,
      name: `section:${sectionId}`,
      document: doc,
      token,
      onStateless: ({ payload }) => {
        const message = JSON.parse(payload) as { type: string; access?: Access };
        if (message.type === 'access' && message.access) setLive(message.access);
      },
      onAuthenticationFailed: () => setLive('none'),
    });
    p.attach();
    return p;
  }, [sectionId, doc, socket, token]);
  useEffect(() => () => { provider.destroy(); doc.destroy(); }, [provider, doc]);
  useEffect(() => setLive(access), [access]);

  const editor = useEditor({
    editable: access === 'edit',
    extensions: [
      StarterKit.configure({ undoRedo: false }),
      Collaboration.configure({ document: doc }),
      CollaborationCaret.configure({ provider, user }),
    ],
  }, [provider]);
  useEffect(() => { editor?.setEditable(live === 'edit'); }, [editor, live]);

  return (
    <div className={`section-body ${live === 'edit' ? 'editable' : 'readonly'}`} data-section={sectionId} data-access={live}>
      <EditorContent editor={editor} />
    </div>
  );
}
