import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api';
import type { PaneAutomation } from './automation';
import type { Session } from './session';
import { GUIDE, type Key, loadSections, PLAY, sleep, type Step, type TourContext } from './tour';

export type TourMode = 'play' | 'guide';

/** The tour's caption card, and the highlighting of the panes it talks about. */
export function Tour({ session, mode, frames, onExit, onFocus }: {
  session: Session;
  mode: TourMode;
  frames: Partial<Record<Key, HTMLIFrameElement | null>>;
  onExit: () => void;
  /** The pane a step is about, other than the Director's: a narrow screen brings it into view. */
  onFocus: (key: Key) => void;
}) {
  const steps = mode === 'play' ? PLAY : GUIDE;
  const [index, setIndex] = useState(0);
  const [finished, setFinished] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);
  const pausedRef = useRef(false);
  pausedRef.current = paused;
  const step: Step | undefined = steps[index];

  const ctx = useMemo<Promise<TourContext>>(async () => {
    const sections = await loadSections(session);
    const character = (key: Key) => session.characters.find((c) => c.key === key)!;
    const director = character('director');
    return {
      session,
      sections,
      character,
      frame: (key) => frames[key] ?? null,
      asDirector: (path, init) => api(director.accessToken, path, init),
      async pane(key): Promise<PaneAutomation> {
        for (let i = 0; i < 100; i++) {
          const auto = frames[key]?.contentWindow?.redacted;
          if (auto && auto.editors.size > 0) return auto;
          await sleep(100);
        }
        throw new Error(`The ${key}'s pane didn't load.`);
      },
    };
  }, [session, frames]);

  useEffect(() => {
    const other = step?.focus.find((f): f is Exclude<Key, 'director'> => f !== 'desk' && f !== 'director');
    if (other && !finished) onFocus(other);
  }, [step, finished, onFocus]);

  // Highlight the step's panes (and the Director's desk inside their pane); dim the rest.
  useEffect(() => {
    const focus = new Set<string>(step?.focus ?? []);
    const touring = !finished && step;
    for (const [key, frame] of Object.entries(frames)) {
      if (!frame) continue;
      const on = focus.has(key) || (key === 'director' && focus.has('desk'));
      frame.classList.toggle('tour-focus', Boolean(touring && on));
      frame.classList.toggle('tour-dim', Boolean(touring && !on));
      frame.contentDocument?.querySelector('.desk')?.classList.toggle('tour-focus', Boolean(touring && focus.has('desk')));
    }
  }, [step, finished, frames]);
  useEffect(() => () => {
    for (const frame of Object.values(frames)) {
      frame?.classList.remove('tour-focus', 'tour-dim');
      frame?.contentDocument?.querySelector('.desk')?.classList.remove('tour-focus');
    }
  }, [frames]);

  // Play: run the step, hold it on screen, move on. Guide: poll until the visitor has done it.
  useEffect(() => {
    if (!step || finished) return;
    let cancelled = false;
    (async () => {
      try {
        const c = await ctx;
        if (mode === 'play') {
          while (pausedRef.current && !cancelled) await sleep(200);
          await step.run?.(c);
          // The caption stays until its effect is on screen, however slow the connection: the hold
          // is time to look at the effect, not time for it to arrive.
          const patience = Date.now() + 20_000;
          while (!cancelled && step.shown && !step.shown(c) && Date.now() < patience) await sleep(150);
          const until = Date.now() + (step.hold ?? 5000);
          while (!cancelled && (Date.now() < until || pausedRef.current)) await sleep(200);
        } else {
          while (!cancelled && !(await step.done!(c).catch(() => false))) await sleep(1000);
          if (!cancelled) await sleep(1200); // let the visitor see the effect
        }
        if (cancelled) return;
        if (index + 1 < steps.length) setIndex(index + 1);
        else setFinished(true);
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    })();
    return () => { cancelled = true; };
  }, [index, step, finished, ctx, mode, steps.length]);

  const restart = (next: TourMode) => {
    sessionStorage.clear();
    location.search = `?tour=${next}`;
  };

  return (
    <aside className="tour" role="region" aria-label={mode === 'play' ? 'Guided demo' : 'Guided tour'} aria-live="polite">
      {finished ? (
        <>
          <p className="tour-step">{mode === 'play' ? 'That\'s the tour' : 'You did it'}</p>
          <h2>{mode === 'play' ? 'Your turn' : 'That\'s everything'}</h2>
          <p>
            {mode === 'play'
              ? 'Everything you just watched was real: API calls and edits, checked by the server. Try it yourself, step by step, or explore freely.'
              : 'Every change you made was checked by the server and recorded in the Director\'s surveillance log. Keep exploring: nothing here is scripted.'}
          </p>
          <div className="tour-actions">
            {mode === 'play' && <button type="button" className="primary" onClick={() => restart('guide')}>Guide me through it</button>}
            <button type="button" className="ghost" onClick={onExit}>Explore freely</button>
          </div>
        </>
      ) : step && (
        <>
          <p className="tour-step">{mode === 'play' ? 'Playing' : 'Your move'} · step {index + 1} of {steps.length}</p>
          <h2>{step.title}</h2>
          <p>{step.body}</p>
          {mode === 'guide' && <p className="tour-waiting">Waiting for you… it moves on by itself when it sees the change.</p>}
          {error && <p className="error" role="alert">{error}</p>}
          <div className="tour-progress" aria-hidden="true">{steps.map((s, i) => <span key={s.title} className={i < index ? 'done' : i === index ? 'now' : ''} />)}</div>
          <div className="tour-actions">
            {mode === 'play' && <button type="button" className="ghost" onClick={() => setPaused(!paused)}>{paused ? 'Resume' : 'Pause'}</button>}
            {mode === 'guide' && <button type="button" className="ghost" onClick={() => (index + 1 < steps.length ? setIndex(index + 1) : setFinished(true))}>Skip this step</button>}
            <button type="button" className="ghost" onClick={onExit}>End the tour</button>
          </div>
        </>
      )}
    </aside>
  );
}
