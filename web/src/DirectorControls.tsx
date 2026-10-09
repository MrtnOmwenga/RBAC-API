import { useEffect, useState } from 'react';
import { api } from './api';
import type { Character, Session } from './session';

interface Member { id: string; role: string; clearance: number; departmentId: string | null }
interface Share { id: string; subjectType: string; subjectId: string; relation: 'reader' | 'editor' }
interface AuditEvent { seq: number; action: string; at: string; detail: Record<string, unknown> }
interface ChainCheck { ok: boolean; events: number; brokenAt?: number }

const DESCRIBE: Record<string, (d: Record<string, unknown>) => string> = {
  'member.update': (d) => {
    const from = d.from as Record<string, unknown>;
    const to = d.to as Record<string, unknown>;
    return from.role !== to.role ? `role ${String(from.role)} → ${String(to.role)}` : `clearance ${String(from.clearance)} → ${String(to.clearance)}`;
  },
  'document.share': (d) => `shared as ${String(d.relation)}`,
  'document.unshare': () => 'share revoked',
  'section.edit': () => 'section edited',
  'organization.create': () => 'agency created',
  'access.denied': (d) => `refused: ${String(d.required ?? 'a request')}`,
};

/** The Director's desk: every control is an ordinary API call, made with the Director's token. */
export function DirectorControls({ session, me, version, onChange }: { session: Session; me: Character; version: number; onChange: () => void }) {
  const [members, setMembers] = useState<Record<string, Member>>({});
  const [shares, setShares] = useState<Share[]>([]);
  const [log, setLog] = useState<AuditEvent[]>([]);
  const [chain, setChain] = useState<ChainCheck | null>(null);
  const [error, setError] = useState<string | null>(null);
  const token = me.accessToken;
  const doc = session.briefingId;

  const refresh = async () => {
    const [list, grants, events, check] = await Promise.all([
      api<Member[]>(token, '/members'),
      api<Share[]>(token, `/documents/${doc}/shares`),
      // What changed and what was refused. Who opened which classified section is in the log too
      // (section.read); listing it here would bury the changes the desk is for.
      api<AuditEvent[]>(token, '/audit-events?limit=6&exclude=section.read'),
      api<ChainCheck>(token, '/audit-events/verify'),
    ]);
    setMembers(Object.fromEntries(list.map((m) => [m.id, m])));
    setShares(grants);
    setLog(events);
    setChain(check);
  };
  useEffect(() => { void refresh(); }, [version]); // eslint-disable-line react-hooks/exhaustive-deps

  const act = async (call: Promise<unknown>) => {
    setError(null);
    try {
      await call;
      await refresh();
      onChange();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const byKey = (key: string) => session.characters.find((c) => c.key === key)!;
  const shareOf = (c: Character) => shares.find((s) => s.subjectType === 'user' && s.subjectId === c.id);
  const setShare = (c: Character, relation: string) => {
    const current = shareOf(c);
    if (relation === 'none') return current ? act(api(token, `/documents/${doc}/shares/${current.id}`, { method: 'DELETE' })) : Promise.resolve();
    return act(api(token, `/documents/${doc}/shares`, { method: 'POST', body: { subjectType: 'user', subjectId: c.id, relation } }));
  };
  const clearance = (c: Character) => (
    <label>
      Clearance
      <select aria-label={`${c.name}: clearance`} value={members[c.id]?.clearance ?? c.clearance} onChange={(e) => act(api(token, `/members/${c.id}`, { method: 'PATCH', body: { clearance: Number(e.target.value) } }))}>
        {session.clearances.map((name, i) => <option key={name} value={i}>{name.replace('_', ' ')}</option>)}
      </select>
    </label>
  );
  const share = (c: Character) => (
    <label>
      Shared
      <select aria-label={`${c.name}: share`} value={shareOf(c)?.relation ?? 'none'} onChange={(e) => { void setShare(c, e.target.value); }}>
        <option value="none">no</option>
        <option value="reader">as reader</option>
        <option value="editor">as editor</option>
      </select>
    </label>
  );
  const analyst = byKey('analyst');

  return (
    <section className="desk" aria-label="Director's controls">
      <div className="control">
        <span className="who">{analyst.name}</span>
        {clearance(analyst)}
        <label>
          Role
          <select aria-label={`${analyst.name}: role`} value={members[analyst.id]?.role ?? analyst.role} onChange={(e) => act(api(token, `/members/${analyst.id}`, { method: 'PATCH', body: { role: e.target.value } }))}>
            <option value="editor">editor</option>
            <option value="viewer">viewer</option>
          </select>
        </label>
      </div>
      {(['intern', 'liaison'] as const).map((key) => {
        const c = byKey(key);
        return <div key={key} className="control"><span className="who">{c.name}</span>{clearance(c)}{share(c)}</div>;
      })}
      {error && <p className="error" role="alert">{error}</p>}
      <div className="log" aria-label="Surveillance log">
        <p className="log-title">
          Surveillance log
          {chain && <span className={`chain ${chain.ok ? 'ok' : 'bad'}`}>{chain.ok ? `chain verified · ${chain.events}` : `broken at #${chain.brokenAt}`}</span>}
        </p>
        <ol>
          {log.map((e) => (
            <li key={e.seq}>
              <span className="seq">#{e.seq}</span> {(DESCRIBE[e.action] ?? (() => e.action))(e.detail)}
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
