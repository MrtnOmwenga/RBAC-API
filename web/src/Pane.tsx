import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider';
import { useCallback, useEffect, useMemo, useState } from 'react';
import * as Y from 'yjs';
import { type Access, api, ApiError, type Briefing, collabUrl, type Explanation } from './api';
import { DirectorControls } from './DirectorControls';
import { SectionBoundary } from './SectionBoundary';
import { SectionEditor } from './SectionEditor';
import type { Session } from './session';

const COLORS: Record<string, string> = { director: '#c0392b', analyst: '#2471a3', intern: '#1e8449', liaison: '#8e44ad' };
const LEVEL = ['unclassified', 'confidential', 'secret', 'top-secret'];
const LABEL: Record<Access, string> = { edit: 'Can edit', read: 'Read only', none: 'No access' };

/** One agent's screen: their briefing, exactly as the server lets them see it. */
export function Pane({ session, characterKey }: { session: Session; characterKey: string }) {
  const me = session.characters.find((c) => c.key === characterKey)!;
  const [briefing, setBriefing] = useState<Briefing | null | undefined>(undefined); // undefined: not loaded yet
  const [denied, setDenied] = useState(false);
  const [version, setVersion] = useState(0); // bumps when the server says access changed
  const [why, setWhy] = useState<Explanation | null>(null);
  const [flash, setFlash] = useState(false); // briefly shown when the server changes what this agent may see

  const load = useCallback(async () => {
    let next: Briefing | null = null;
    try {
      next = await api<Briefing>(me.accessToken, `/documents/${session.briefingId}/briefing`);
    } catch (e) {
      if (!(e instanceof ApiError && (e.status === 403 || e.status === 404))) return;
    }
    const shape = (b: Briefing | null) => (b ? `${b.access}:${b.sections.map((s) => s.access).join()}` : 'denied');
    setBriefing((previous) => {
      if (previous !== undefined && shape(previous) !== shape(next) && (previous || next)) {
        setFlash(true);
        setTimeout(() => setFlash(false), 2500);
      }
      return next;
    });
    setDenied(next === null);
  }, [me.accessToken, session.briefingId]);

  // One WebSocket per pane, shared by every section; plus a personal channel that pings whenever
  // anything about access changes in the agency.
  const socket = useMemo(() => new HocuspocusProviderWebsocket({ url: collabUrl() }), []);
  useEffect(() => {
    const personal = new HocuspocusProvider({
      websocketProvider: socket, name: `member:${me.id}`, document: new Y.Doc(), token: me.accessToken,
      onStateless: () => { setVersion((v) => v + 1); },
    });
    personal.attach();
    return () => { personal.destroy(); socket.destroy(); };
  }, [socket, me.id, me.accessToken]);
  useEffect(() => { void load(); if (why) void explain(); }, [load, version]); // eslint-disable-line react-hooks/exhaustive-deps

  const explain = async () => setWhy(await api<Explanation>(me.accessToken, `/documents/${session.briefingId}/explain`).catch(() => null));

  const access: Access = briefing?.access ?? 'none';
  return (
    <div className={`pane pane-${me.key}`}>
      <header className="pane-header" style={{ borderColor: COLORS[me.key] }}>
        <div>
          <h2>{me.name}</h2>
          <p>{me.title}</p>
        </div>
        <div className="badges">
          <span className={`clearance level-${LEVEL[briefing?.clearance ?? me.clearance]}`}>{session.clearances[briefing?.clearance ?? me.clearance]?.replace('_', ' ')}</span>
          <span className={`access access-${access}`} aria-label="Access to this briefing">{LABEL[access]}</span>
        </div>
      </header>

      {me.key === 'director' && <DirectorControls session={session} me={me} version={version} onChange={load} />}

      {flash && <p className="flash" role="status">Access changed by the server</p>}
      <article className="paper">
        {denied && <div className="stamp" role="status">No access</div>}
        {briefing && (
          <>
            <div className="paper-top">
              <h3>{briefing.title}</h3>
              <button type="button" className="link" onClick={() => (why ? setWhy(null) : void explain())}>
                {why ? 'Hide' : 'Why can I see this?'}
              </button>
            </div>
            {why && (
              <aside className="why" aria-label="Why can I see this?">
                {why.reasons.length === 0 ? <p>No role or share gives you access.</p> : (
                  <ul>{why.reasons.map((r) => <li key={r.because}><strong>{r.access === 'edit' ? 'Edit' : 'Read'}</strong>: {r.because}</li>)}</ul>
                )}
                <p>Clearance <strong>{why.clearance.replace('_', ' ')}</strong>{why.redactedSections.length ? `: ${why.redactedSections.length} section(s) above it are redacted.` : ': nothing is redacted.'}</p>
              </aside>
            )}
            {briefing.sections.map((s) => (
              <section key={s.id} className={`section level-${LEVEL[s.classification]}`}>
                <p className="classification">{session.clearances[s.classification]?.replace('_', ' ')}</p>
                {s.access === 'none' ? (
                  <div className="redacted" aria-label="Redacted section">
                    <span className="bar" style={{ width: '38%' }} />
                    {Array.from({ length: Math.min(4, Math.max(1, Math.round((s.redactedLength ?? 40) / 80))) }, (_, i) => (
                      <span key={i} className="bar" style={{ width: `${70 + ((i * 37) % 30)}%` }} />
                    ))}
                  </div>
                ) : (
                  <>
                    <h4>{s.heading}</h4>
                    {/* Keyed by section only: access changes update the live editor in place. A remount
                        would register the same room twice on the shared socket. */}
                    <SectionBoundary>
                      <SectionEditor
                        key={s.id}
                        sectionId={s.id}
                        access={s.access}
                        socket={socket}
                        token={me.accessToken}
                        user={{ name: me.name, color: COLORS[me.key] ?? '#555' }}
                      />
                    </SectionBoundary>
                  </>
                )}
              </section>
            ))}
          </>
        )}
      </article>
    </div>
  );
}
