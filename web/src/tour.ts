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
  /** Play: whether the effect the caption describes is on screen yet. The hold starts from then. */
  shown?: (ctx: TourContext) => boolean;
  /** Play: how long to wait for `shown` before moving on regardless (ms; 20 s unless given). */
  patience?: number;
  /** Play: requests made in front of the visitor, each reported as one line under the caption. */
  evidence?: (ctx: TourContext) => Promise<string[]>;
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

// What a pane's page shows, read straight from its document.
const sees = (ctx: TourContext, key: Key, text: string) => (ctx.frame(key)?.contentDocument?.body.innerText ?? '').includes(text);

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
    shown: (ctx) => sees(ctx, 'analyst', 'The handover moves'),
    hold: 2500,
  },
  {
    title: 'Demoted mid-sentence',
    body: 'The Director lowers the Analyst\'s clearance to Confidential. Open connections are locked before the change is saved, so the very next keystroke is refused, and "The asset" blacks out on the Analyst\'s screen.',
    focus: ['desk', 'analyst'],
    run: async (ctx) => {
      await ctx.asDirector(`/members/${ctx.character('analyst').id}`, { method: 'PATCH', body: { clearance: 1 } });
      await typing;
    },
    shown: (ctx) => !sees(ctx, 'analyst', 'The handover moves'),
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
    shown: (ctx) => !sees(ctx, 'intern', 'Lisbon Maritime Trade Fair'),
    hold: 7000,
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
    shown: (ctx) => sees(ctx, 'liaison', 'Exfiltration'),
    hold: 7000,
  },
  {
    title: 'Everything is on the record',
    body: 'Each change is in the surveillance log: a hash chain the database won\'t let the API edit or delete. "Chain verified" is recomputed from scratch every time.',
    focus: ['desk'],
    hold: 7000,
  },
];

const internSees = (ctx: TourContext, text: string) => sees(ctx, 'intern', text);

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

/** One request, as a line of evidence: what was asked, as whom, and what the server answered. */
async function line(token: string, method: string, path: string, body: unknown, say: (status: number, answer: unknown) => string): Promise<string> {
  const res = await fetch(path, {
    method, headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const answer: unknown = await res.json().catch(() => null);
  return `${method} ${path.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, '…')} → ${res.status} ${say(res.status, answer)}`;
}
const refusal = (_: number, answer: unknown) => String((answer as { detail?: string } | null)?.detail ?? '');
const count = (noun: string) => (_: number, answer: unknown) => `${Array.isArray(answer) ? answer.length : 0} ${noun}`;

// The auditor exists only once their chapter has created them.
let auditor: { id: string; token: string } | null = null;

/*
 * Chapters: shorter tours, each about one thing the first tour has no time for. They play
 * themselves like "Play it for me", against the same agency, with the same rule: every effect is a
 * real request, and where the effect isn't visible in a pane, the request and the server's answer
 * are shown under the caption.
 */
export const CHAPTERS = {
  expiry: {
    name: 'A share that runs out',
    steps: [
      {
        title: 'A share with an end',
        body: 'The Director shares the briefing with the Liaison for twenty seconds. Access with an end date is ordinary: a contractor for a week, a reviewer for a day. Here it is short enough to watch.',
        focus: ['desk', 'liaison'],
        run: async (ctx) => {
          const liaison = ctx.character('liaison').id;
          const shares = await ctx.asDirector<{ id: string; subjectId: string }[]>(`/documents/${ctx.session.briefingId}/shares`);
          for (const s of shares.filter((x) => x.subjectId === liaison)) await ctx.asDirector(`/documents/${ctx.session.briefingId}/shares/${s.id}`, { method: 'DELETE' });
          await ctx.asDirector(`/documents/${ctx.session.briefingId}/shares`, {
            method: 'POST', body: { subjectType: 'user', subjectId: liaison, relation: 'reader', expiresInSeconds: 20 },
          });
        },
        shown: (ctx) => sees(ctx, 'liaison', 'Exfiltration'),
        hold: 5000,
      },
      {
        title: 'Now nobody does anything',
        body: 'No click, no request. When the twenty seconds are up the share stops counting. The server checks its open connections every few seconds for exactly this, closes the Liaison\'s, and their page goes back to "No access". Keep watching the bottom right.',
        focus: ['liaison'],
        shown: (ctx) => !sees(ctx, 'liaison', 'Exfiltration'),
        patience: 60_000,
        hold: 6000,
      },
      {
        title: 'Ended, and still on the record',
        body: 'The surveillance log keeps the share and the time it was due to end. Had the Liaison asked the API directly, they would have been refused from the instant it expired; the connection that was already open followed within seconds.',
        focus: ['desk'],
        hold: 7000,
      },
    ] as Step[],
  },
  auditor: {
    name: 'The auditor',
    steps: [
      {
        title: 'A new colleague',
        body: 'The Director adds an auditor: someone whose job is to check what happened, and who must not be able to change it. They have no pane here, so their requests are shown below, with the server\'s answers.',
        focus: ['desk'],
        evidence: async (ctx) => {
          const director = ctx.character('director').accessToken;
          const email = `auditor-${crypto.randomUUID()}@demo.invalid`;
          const password = crypto.randomUUID() + crypto.randomUUID();
          let id = '';
          const made = await line(director, 'POST', '/members', { email, name: 'A. Hale', password, role: 'auditor', departmentId: null }, (_, a) => {
            id = (a as { id: string }).id;
            return 'A. Hale, auditor';
          });
          const login = await fetch('/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) });
          auditor = { id, token: ((await login.json()) as { accessToken: string }).accessToken };
          return [made, `POST /auth/login → ${login.status} signed in as the auditor`];
        },
        hold: 7000,
      },
      {
        title: 'Reads the whole record',
        body: 'The auditor may read every member, every document\'s existence and the whole log, across all divisions. Reading the record is not clearance, though: the briefing comes back to them with its classified sections redacted, as it does to the Intern.',
        focus: ['desk'],
        evidence: async (ctx) => {
          const token = auditor!.token;
          return [
            await line(token, 'GET', '/members', undefined, count('members, in every division')),
            await line(token, 'GET', '/audit-events', undefined, count('events')),
            await line(token, 'GET', '/audit-events/verify', undefined, (_, a) => ((a as { ok: boolean }).ok ? 'the chain verifies' : 'the chain is broken')),
            await line(token, 'GET', `/documents/${ctx.session.briefingId}/briefing`, undefined, (_, a) => {
              const sections = (a as { sections: { view: string }[] }).sections;
              return `${sections.filter((s) => s.view === 'none').length} of ${sections.length} sections redacted`;
            }),
          ];
        },
        hold: 9000,
      },
      {
        title: 'Changes nothing',
        body: 'Three things an auditor might be tempted, or tricked, into doing: raising a clearance, sharing the briefing, deleting it. Each is refused by the same table that allowed the reads.',
        focus: ['desk'],
        evidence: async (ctx) => {
          const token = auditor!.token;
          const doc = ctx.session.briefingId;
          return [
            await line(token, 'PATCH', `/members/${ctx.character('intern').id}`, { clearance: 3 }, refusal),
            await line(token, 'POST', `/documents/${doc}/shares`, { subjectType: 'user', subjectId: auditor!.id, relation: 'editor' }, refusal),
            await line(token, 'DELETE', `/documents/${doc}`, undefined, refusal),
          ];
        },
        hold: 9000,
      },
      {
        title: 'And the attempts are on the record',
        body: 'Each refusal was written to the log in a transaction of its own, because the refused request rolled back. The auditor\'s own attempts are now evidence the next auditor can read.',
        focus: ['desk'],
        evidence: async (ctx) => [
          await line(ctx.character('director').accessToken, 'GET', `/audit-events?action=access.denied&actorId=${auditor!.id}`, undefined, count('refusals recorded for the auditor')),
        ],
        hold: 8000,
      },
    ] as Step[],
  },
} as const;
export type Chapter = keyof typeof CHAPTERS;

export { sleep };
