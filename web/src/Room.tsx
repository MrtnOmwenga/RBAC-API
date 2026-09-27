import type { Session } from './session';

const ORDER = ['director', 'analyst', 'intern', 'liaison'] as const;

export function Room({ session }: { session: Session }) {
  const restart = () => {
    sessionStorage.clear();
    location.search = '';
  };
  return (
    <div className="room">
      <header className="room-bar">
        <h1 className="wordmark small">RE<span className="bar">DACT</span>ED</h1>
        <p className="hint">
          You are the <strong>Director</strong> (top left). Select words in your copy and classify
          them: watch them black out for the others · lower the Analyst&apos;s clearance while they
          type · share the briefing with the Liaison · ask any agent &ldquo;Why can I see this?&rdquo;
        </p>
        <button type="button" className="ghost" onClick={restart}>New agency</button>
      </header>
      <div className="grid">
        {ORDER.map((key) => {
          const c = session.characters.find((x) => x.key === key)!;
          return <iframe key={key} title={`${c.name}, ${c.title}`} src={`/?pane=${key}`} className="pane-frame" />;
        })}
      </div>
    </div>
  );
}
