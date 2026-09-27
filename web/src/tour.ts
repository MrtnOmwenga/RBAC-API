import { api, type Briefing } from './api';
import type { PaneAutomation } from './automation';
import type { Character, Session } from './session';

/*
 * The two guided tours of the briefing room.
 *
 * "Play it for me" performs each step itself: the Director's changes are the Director's own API
 * calls, and the typing and classifying happen in the panes' real editors. Nothing is animated or
 * faked; the other panes react because the server tells them to.
 *
 * "Guide me" asks the visitor to do each step and moves on when the step has happened, checked
 * against the server (or, for what's on screen, against that pane's page).
 */

export type Key = Character['key'];

export interface TourContext {
  session: Session;
  sections: Record<string, string>; // section heading → id
  frame(key: Key): HTMLIFrameElement | null;
  /** A pane's automation, once its editors have loaded. */
  pane(key: Key): Promise<PaneAutomation>;
  asDirector<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T>;
  character(key: Key): Character;
}

export interface Step {
  title: string;
  body: string;
  /** The panes to highlight; "desk" highlights the Director's controls inside their pane. */
  focus: (Key | 'desk')[];
  /** Play: what to do, and how long to leave the step on screen afterwards (ms). */
  run?: (ctx: TourContext) => Promise<void>;
  hold?: number;
  /** Guide: whether the visitor has done it yet (polled). */
  done?: (ctx: TourContext) => Promise<boolean>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function loadSections(session: Session): Promise<Record<string, string>> {
  const director = session.characters.find((c) => c.key === 'director')!;
  const b = await api<Briefing>(director.accessToken, `/documents/${session.briefingId}/briefing`);
  return Object.fromEntries(b.sections.map((s) => [s.heading ?? '', s.id]));
}

let typing: Promise<void> = Promise.resolve();

export const PLAY: Step[] = [
  {
    title: 'Four agents, one briefing',
    body: 'A Director, an Analyst, an Intern and a Liaison have the same mission briefing open. Each pane is a separate browser session with its own login and connection, like four laptops.',
    focus: ['director', 'analyst', 'intern', 'liaison'],
    hold: 7000,
  },
  {
    title: 'The Intern sees black bars',
    body: 'The Intern is unclassified. "The asset" and "Exfiltration" aren\'t hidden in their page: the server never sent them. The bars are sized to the hidden text, rounded so lengths don\'t leak.',
    focus: ['intern'],
    hold: 8000,
  },
  {
    title: 'The Analyst is writing',
    body: 'The Analyst, cleared to Secret, is adding a line to "The asset". Every keystroke is authorized by the server before it reaches anyone else.',
    focus: ['analyst'],
    run: async (ctx) => {
      const analyst = await ctx.pane('analyst');
      typing = analyst.typeInto(ctx.sections['The asset']!, ' The handover moves to the old lighthouse at dawn, weather permitting.', 14);
    },
    hold: 3000,
  },
  {
    title: 'Demoted mid-sentence',
    body: 'The Director lowers the Analyst\'s clearance to Confidential. Open connections are locked before the change is saved, so the very next keystroke is refused, and "The asset" blacks out on the Analyst\'s screen.',
    focus: ['desk', 'analyst'],
    run: async (ctx) => {
      await ctx.asDirector(`/members/${ctx.character('analyst').id}`, { method: 'PATCH', body: { clearance: 1 } });
      await typing;
    },
    hold: 6000,
  },
  {
    title: 'Classify a few words',
    body: 'The Director marks "Lisbon Maritime Trade Fair" Confidential, the way you\'d make it bold. The Intern\'s copy is rewritten by the server within 100 ms: the words turn into a bar, and never reach their browser.',
    focus: ['director', 'intern'],
    run: async (ctx) => {
      const director = await ctx.pane('director');
      director.classify(ctx.sections['Cover story']!, 'Lisbon Maritime Trade Fair', 1);
    },
    hold: 8000,
  },
  {
    title: 'Share it across divisions',
    body: 'The Liaison works in another division and had no access at all. One share later the briefing appears, Exfiltration plan included, because they are cleared to Top Secret.',
    focus: ['desk', 'liaison'],
    run: async (ctx) => {
      await ctx.asDirector(`/documents/${ctx.session.briefingId}/shares`, {
        method: 'POST', body: { subjectType: 'user', subjectId: ctx.character('liaison').id, relation: 'reader' },
      });
    },
    hold: 8000,
  },
  {
    title: 'Everything is on the record',
    body: 'Each change is in the surveillance log: a hash chain the database won\'t let the API edit or delete. "Chain verified" is recomputed from scratch every time.',
    focus: ['desk'],
    hold: 7000,
  },
];

// Text the Intern's page shows, read straight from their document.
const internSees = (ctx: TourContext, text: string) => (ctx.frame('intern')?.contentDocument?.body.innerText ?? '').includes(text);

export const GUIDE: Step[] = [
  {
    title: 'Lower the Analyst\'s clearance',
    body: 'In the Director\'s desk (top left), set R. Okoye\'s clearance to "confidential". Watch "The asset" black out on the Analyst\'s screen (top right).',
    focus: ['desk', 'analyst'],
    done: async (ctx) => {
      const members = await ctx.asDirector<{ id: string; clearance: number }[]>('/members');
      return (members.find((m) => m.id === ctx.character('analyst').id)?.clearance ?? 2) < 2;
    },
  },
  {
    title: 'Classify a few words',
    body: 'In the Director\'s "Cover story", select "Lisbon Maritime Trade Fair" and press C in the toolbar that appears. Watch the Intern\'s copy (bottom left).',
    focus: ['director', 'intern'],
    done: async (ctx) => !internSees(ctx, 'Lisbon Maritime Trade Fair'),
  },
  {
    title: 'Let the Liaison in',
    body: 'In the Director\'s desk, set S. Laurent\'s "Shared" to "as reader". The Liaison (bottom right) is in another division and has no access yet.',
    focus: ['desk', 'liaison'],
    done: async (ctx) => {
      const shares = await ctx.asDirector<{ subjectId: string }[]>(`/documents/${ctx.session.briefingId}/shares`);
      return shares.some((s) => s.subjectId === ctx.character('liaison').id);
    },
  },
  {
    title: 'Ask why',
    body: 'In the Intern\'s pane, press "Why can I see this?". Every decision the server makes can explain itself.',
    focus: ['intern'],
    done: async (ctx) => Boolean(ctx.frame('intern')?.contentDocument?.querySelector('.why')),
  },
];

export { sleep };
