import { type HocuspocusProviderWebsocket, HocuspocusProvider } from '@hocuspocus/provider';
import Collaboration from '@tiptap/extension-collaboration';
import CollaborationCaret from '@tiptap/extension-collaboration-caret';
import { EditorContent, useEditor, useEditorState } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { useEffect, useMemo, useState } from 'react';
import * as Y from 'yjs';
import type { Access } from './api';
import { Classified, Redaction } from './marks';

interface Props {
  sectionId: string;
  /** The full text, or the server's projection at `projectionLevel` (read-only). */
  view: 'full' | 'projection';
  projectionLevel?: number;
  access: Access;
  clearance: number;
  clearances: string[];
  socket: HocuspocusProviderWebsocket;
  token: string;
  user: { name: string; color: string };
}

const SHORT = ['U', 'C', 'S', 'TS'];

/**
 * One section's live text. The server decides whether this connection may write: a read-only
 * connection's edits are dropped there, and `editable` here just keeps the UI honest about it.
 */
export function SectionEditor({ sectionId, view, projectionLevel, access, clearance, clearances, socket, token, user }: Props) {
  const [live, setLive] = useState<Access>(access);
  const room = view === 'full' ? `section:${sectionId}` : `projection:${sectionId}:${projectionLevel ?? 0}`;
  const doc = useMemo(() => new Y.Doc(), [room]);
  const provider = useMemo(() => {
    const p = new HocuspocusProvider({
      websocketProvider: socket,
      name: room,
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
  }, [room, doc, socket, token]);
  useEffect(() => () => { provider.destroy(); doc.destroy(); }, [provider, doc]);
  useEffect(() => setLive(access), [access]);

  const editor = useEditor({
    editable: view === 'full' && access === 'edit',
    editorProps: { attributes: { spellcheck: 'false' } },
    extensions: [
      StarterKit.configure({ undoRedo: false }),
      Classified,
      Redaction,
      Collaboration.configure({ document: doc }),
      ...(view === 'full' ? [CollaborationCaret.configure({ provider, user })] : []),
    ],
  }, [provider]);
  const writable = view === 'full' && live === 'edit';
  useEffect(() => { editor?.setEditable(writable); }, [editor, writable]);
  const selection = useEditorState({ editor, selector: ({ editor: e }) => (e ? !e.state.selection.empty : false) });

  return (
    <div className={`section-body ${writable ? 'editable' : 'readonly'}`} data-section={sectionId} data-access={live} data-view={view}>
      {writable && editor && (
        <div className="classify" role="toolbar" aria-label="Classify selected words">
          <span>Classify selection</span>
          {clearances.slice(1, clearance + 1).map((name, i) => (
            <button
              key={name}
              type="button"
              disabled={!selection}
              title={`Mark the selected words ${name.replace('_', ' ')}`}
              onMouseDown={(e) => e.preventDefault()} // keep the selection
              onClick={() => editor.chain().focus().setMark('classified', { level: i + 1 }).run()}
            >
              {SHORT[i + 1]}
            </button>
          ))}
          <button type="button" disabled={!selection} title="Remove the classification from the selected words" onMouseDown={(e) => e.preventDefault()} onClick={() => editor.chain().focus().unsetMark('classified').run()}>
            Clear
          </button>
        </div>
      )}
      <EditorContent editor={editor} />
    </div>
  );
}
