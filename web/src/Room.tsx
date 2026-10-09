import { useMemo, useState } from 'react';
import type { Session } from './session';
import { Proof } from './Proof';
import { Tour, type TourMode } from './Tour';
import type { Key } from './tour';

const ORDER = ['director', 'analyst', 'intern', 'liaison'] as const;

export function Room({ session }: { session: Session }) {
  const params = new URLSearchParams(location.search);
  const requested = params.get('tour');
  const [tour, setTour] = useState<TourMode | null>(requested === 'play' || requested === 'guide' ? requested : null);
  const [frames, setFrames] = useState<Partial<Record<Key, HTMLIFrameElement | null>>>({});
  // One stable ref callback per pane: a new function each render would detach and reattach them.
  const frameRefs = useMemo(() => Object.fromEntries(ORDER.map((key) => [key, (el: HTMLIFrameElement | null) => {
    setFrames((f) => (f[key] === el ? f : { ...f, [key]: el }));
  }])) as Record<Key, (el: HTMLIFrameElement | null) => void>, []);

  const restart = () => {
    sessionStorage.clear();
    location.search = '';
  };
  const endTour = () => {
    setTour(null);
    history.replaceState(null, '', '?room');
  };
  const ready = ORDER.every((k) => frames[k]);
  // On a narrow screen the Director's pane sits above one other pane, so a change and its effect
  // are on screen together. All four panes stay loaded; this only chooses which one is shown.
  const [beside, setBeside] = useState<Key>('analyst');
  const [proof, setProof] = useState(false);
  const closeProof = useMemo(() => () => setProof(false), []);

  return (
    <div className={`room ${tour ? 'touring' : ''}`}>
      <header className="room-bar">
        <h1 className="wordmark small">RE<span className="bar">DACT</span>ED</h1>
        <p className="hint">
          You are the <strong>Director</strong> (top left). Select words in your copy and classify
          them: watch them black out for the others · lower the Analyst&apos;s clearance while they
          type · share the briefing with the Liaison · ask any agent &ldquo;Why can I see this?&rdquo;
        </p>
        {!tour && (
          <>
            <button type="button" className="ghost" onClick={() => setTour('play')}>Play it for me</button>
            <button type="button" className="ghost" onClick={() => setTour('guide')}>Guide me</button>
          </>
        )}
        <button type="button" className="ghost" onClick={() => setProof(true)}>Is this real?</button>
        <button type="button" className="ghost" onClick={restart}>New agency</button>
      </header>
      <div className="pane-switch" role="group" aria-label="Agent shown below the Director">
        {ORDER.filter((key) => key !== 'director').map((key) => (
          <button key={key} type="button" aria-pressed={beside === key} onClick={() => setBeside(key)}>
            {session.characters.find((x) => x.key === key)!.title.split(',')[0]}
          </button>
        ))}
      </div>
      <div className="grid">
        {ORDER.map((key) => {
          const c = session.characters.find((x) => x.key === key)!;
          const shown = key === 'director' || key === beside;
          return <iframe key={key} ref={frameRefs[key]} title={`${c.name}, ${c.title}`} src={`/?pane=${key}`} className={`pane-frame ${shown ? '' : 'aside'}`} />;
        })}
      </div>
      {proof && <Proof session={session} onClose={closeProof} />}
      {tour && ready && <Tour session={session} mode={tour} frames={frames} onExit={endTour} onFocus={setBeside} />}
    </div>
  );
}
