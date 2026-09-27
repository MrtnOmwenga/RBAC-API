import { Mark, mergeAttributes } from '@tiptap/react';

/*
 * The two marks behind word-level classification. `classified` is applied by cleared editors to
 * the full text; the Yjs binding stores it as `classified: { level }` on the text, which the server
 * reads. `redaction` exists only in projections the server writes: the bar standing in for words
 * the reader isn't cleared for.
 */

export const Classified = Mark.create({
  name: 'classified',
  addAttributes() {
    return {
      level: {
        default: 1,
        parseHTML: (element) => Number(element.getAttribute('data-level')),
        renderHTML: (attributes: { level: number }) => ({ 'data-level': attributes.level }),
      },
    };
  },
  parseHTML: () => [{ tag: 'span[data-classified]' }],
  renderHTML: ({ HTMLAttributes }) => ['span', mergeAttributes(HTMLAttributes, { 'data-classified': '', class: 'classified' }), 0],
});

export const Redaction = Mark.create({
  name: 'redaction',
  parseHTML: () => [{ tag: 'span[data-redaction]' }],
  renderHTML: () => ['span', { 'data-redaction': '', class: 'redaction', 'aria-label': 'redacted words' }, 0],
});
