import { useState } from 'react';
import { startSession } from './session';

// "?tour=play" or "?tour=guide" (from Lighthouse's launch page) puts that tour first.
const requested = new URLSearchParams(location.search).get('tour');

export function Landing() {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const enter = async (tour?: 'play' | 'guide') => {
    setBusy(true);
    try {
      await startSession();
      location.search = tour ? `?room&tour=${tour}` : '?room';
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };
  const choices = [
    { tour: 'play' as const, label: 'Play it for me', note: 'A two-minute demo that runs itself' },
    { tour: 'guide' as const, label: 'Guide me', note: 'Do it yourself, one step at a time' },
    { tour: undefined, label: 'Enter the briefing room', note: 'No tour: explore freely' },
  ].sort((a, b) => (a.tour === requested ? -1 : b.tour === requested ? 1 : 0));
  return (
    <main className="landing">
      <p className="eyebrow">A live permissions demo</p>
      <h1 className="wordmark">RE<span className="bar">DACT</span>ED</h1>
      <p className="lede">
        A briefing room where access changes while people type. Four agents open the same mission
        briefing, and each sees only what their role, division, shares and clearance allow.
        Everything you see is enforced on the server: text you aren&apos;t cleared for never reaches
        your browser.
      </p>
      <div className="choices">
        {choices.map((c, i) => (
          <button key={c.label} type="button" className={i === 0 ? 'primary' : 'ghost'} onClick={() => enter(c.tour)} disabled={busy}>
            <span>{busy && i === 0 ? 'Preparing your agency…' : c.label}</span>
            <small>{c.note}</small>
          </button>
        ))}
      </div>
      {error && <p className="error" role="alert">{error}</p>}
      <p className="fineprint">
        You get a private, throwaway agency (deleted after two hours). The demo is the front end of
        {' '}<a href="https://github.com/MrtnOmwenga/RBAC-API">RBAC-API</a>: NestJS, PostgreSQL row-level
        security, and Yjs collaboration with per-connection authorization.
      </p>
    </main>
  );
}
