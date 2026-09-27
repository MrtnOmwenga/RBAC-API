import { useState } from 'react';
import { startSession } from './session';

export function Landing() {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const enter = async () => {
    setBusy(true);
    try {
      await startSession();
      location.search = '?room';
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };
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
      <button type="button" className="primary" onClick={enter} disabled={busy}>
        {busy ? 'Preparing your agency…' : 'Enter the briefing room'}
      </button>
      {error && <p className="error" role="alert">{error}</p>}
      <p className="fineprint">
        You get a private, throwaway agency (deleted after two hours). The demo is the front end of
        {' '}<a href="https://github.com/MrtnOmwenga/RBAC-API">RBAC-API</a>: NestJS, PostgreSQL row-level
        security, and Yjs collaboration with per-connection authorization.
      </p>
    </main>
  );
}
