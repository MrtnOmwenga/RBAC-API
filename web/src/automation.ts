import type { Editor } from '@tiptap/react';

/*
 * What the guided tour may do inside a pane: the same things the pane's own buttons do, through
 * the same editor and the same server checks. The room (the pane's parent page, same origin)
 * reads this registry from the pane's window. It grants nothing the pane's user couldn't do by
 * hand: every edit still goes over that pane's own connection and is authorized by the server.
 */

export interface PaneAutomation {
  editors: Map<string, Editor>; // by section id
  /** Types text at the end of a section, a character at a time, like a person would. */
  typeInto(sectionId: string, text: string, charsPerSecond?: number): Promise<void>;
  /** Selects a phrase in a section and marks it classified at `level`, like the toolbar does. */
  classify(sectionId: string, phrase: string, level: number): boolean;
  /** The highest classification marked in a section's text. */
  maxMark(sectionId: string): number;
}

declare global {
  interface Window { redacted?: PaneAutomation }
}

function find(editor: Editor, phrase: string): { from: number; to: number } | null {
  let found: { from: number; to: number } | null = null;
  editor.state.doc.descendants((node, pos) => {
    if (found || !node.isText || !node.text) return !found;
    const i = node.text.indexOf(phrase);
    if (i >= 0) found = { from: pos + i, to: pos + i + phrase.length };
    return !found;
  });
  return found;
}

export function automation(): PaneAutomation {
  if (window.redacted) return window.redacted;
  const editors = new Map<string, Editor>();
  window.redacted = {
    editors,
    async typeInto(sectionId, text, charsPerSecond = 16) {
      // Bring the section into view first, so the typing can be watched.
      editors.get(sectionId)?.view.dom.scrollIntoView({ block: 'center', behavior: 'smooth' });
      await new Promise((r) => setTimeout(r, 600));
      for (const ch of text) {
        const editor = editors.get(sectionId);
        if (!editor || !editor.isEditable) return; // access was taken away mid-sentence
        editor.chain().focus('end').insertContent(ch).run();
        await new Promise((r) => setTimeout(r, 1000 / charsPerSecond));
      }
    },
    classify(sectionId, phrase, level) {
      const editor = editors.get(sectionId);
      const range = editor && find(editor, phrase);
      if (!editor || !range || !editor.isEditable) return false;
      editor.view.dom.scrollIntoView({ block: 'center', behavior: 'smooth' });
      return editor.chain().focus().setTextSelection(range).setMark('classified', { level }).run();
    },
    maxMark(sectionId) {
      const editor = editors.get(sectionId);
      let max = 0;
      editor?.state.doc.descendants((node) => {
        for (const mark of node.marks) if (mark.type.name === 'classified') max = Math.max(max, Number(mark.attrs.level) || 0);
      });
      return max;
    },
  };
  return window.redacted;
}
