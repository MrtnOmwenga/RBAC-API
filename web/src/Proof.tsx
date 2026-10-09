import { useEffect, useState } from 'react';
import type { Session } from './session';

/*
 * "How do I know this is real?" The landing page says everything is enforced on the server. This
 * panel lets a visitor check: it makes the requests in front of them, with each agent's own token,
 * and shows what the server sent back, untouched.
 */

interface Exchange { request: string; status: number; body: string }

async function ask(token: string, method: string, path: string, body?: unknown): Promise<Exchange> {
  const res = await fetch(path, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let shown = text;
  try {
    shown = JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    // not JSON: shown as it came
  }
  return { request: `${method} ${path}`, status: res.status, body: shown };
}

function Answer({ exchange }: { exchange: Exchange | null }) {
  if (!exchange) return null;
  return (
    <figure className="proof-answer">
      <figcaption><code>{exchange.request}</code> <span className={exchange.status < 400 ? 'ok' : 'refused'}>{exchange.status}</span></figcaption>
      <pre tabIndex={0}>{exchange.body}</pre>
    </figure>
  );
}

export function Proof({ session, onClose }: { session: Session; onClose: () => void }) {
  const who = (key: string) => session.characters.find((c) => c.key === key)!;
  const [seen, setSeen] = useState<Record<string, { role: string; clearance: number } | null>>({});
  const [redacted, setRedacted] = useState<Exchange | null>(null);
  const [refused, setRefused] = useState<Exchange | null>(null);

  // What the server says about each token, asked now.
  useEffect(() => {
    void Promise.all(session.characters.map(async (c) => {
      const res = await fetch('/me', { headers: { authorization: `Bearer ${c.accessToken}` } });
      return [c.key, res.ok ? await res.json() as { role: string; clearance: number } : null] as const;
    })).then((all) => setSeen(Object.fromEntries(all)));
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [session, onClose]);

  const asIntern = async () => {
    const answer = await ask(who('intern').accessToken, 'GET', `/documents/${session.briefingId}/briefing`);
    // Only the sections, the part of the answer the question is about, with the redacted ones first.
    try {
      const { sections } = JSON.parse(answer.body) as { sections: { view: string }[] };
      answer.body = JSON.stringify([...sections].sort((a, b) => Number(a.view !== 'none') - Number(b.view !== 'none')), null, 2);
    } catch {
      // shown whole
    }
    setRedacted(answer);
  };
  const overreach = async () => setRefused(await ask(who('intern').accessToken, 'PATCH', `/members/${who('intern').id}`, { clearance: 3 }));

  return (
    <div className="proof-backdrop" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <section className="proof" role="dialog" aria-modal="true" aria-label="How do I know this is real?">
        <header>
          <h2>How do I know this is real?</h2>
          <button type="button" className="ghost" onClick={onClose}>Close</button>
        </header>
        <p>Nothing in this room is animated or scripted. Each check below is a request made now, from your browser, and the server&apos;s answer shown as it arrived.</p>

        <h3>1. Four separate sign-ins</h3>
        <p>Each pane holds its own token. This is what the server says each one is, asked just now:</p>
        <table>
          <thead><tr><th>Agent</th><th>Member</th><th>Role</th><th>Clearance</th></tr></thead>
          <tbody>
            {session.characters.map((c) => (
              <tr key={c.key}>
                <td>{c.name}</td>
                <td><code>{c.id.slice(0, 8)}</code></td>
                <td>{seen[c.key]?.role ?? '…'}</td>
                <td>{seen[c.key] ? session.clearances[seen[c.key]!.clearance]?.replace('_', ' ') : '…'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="proof-note">Change the Analyst&apos;s clearance at the Director&apos;s desk and open this again: the server&apos;s answer changes, and the token doesn&apos;t.</p>

        <h3>2. The hidden text is never sent</h3>
        <p>Ask for the briefing with the Intern&apos;s token. A section they aren&apos;t cleared for comes back with no heading and no text, only a rounded length for the bar.</p>
        <button type="button" className="primary" onClick={() => void asIntern()}>Fetch the briefing as the Intern</button>
        <Answer exchange={redacted} />

        <h3>3. The server refuses, whatever the page sends</h3>
        <p>The Intern&apos;s page has no control for this, so send it anyway: the Intern giving themselves top secret clearance.</p>
        <button type="button" className="primary" onClick={() => void overreach()}>Try it as the Intern</button>
        <Answer exchange={refused} />
        {refused && <p className="proof-note">The refusal is now in the Director&apos;s surveillance log, as a link in the same hash chain as every change.</p>}

        <h3>4. Check without trusting this page</h3>
        <ol>
          <li>Open your browser&apos;s developer tools and go to the Network tab.</li>
          <li>Pick a word you can read in the Director&apos;s copy of &ldquo;The asset&rdquo;, such as the asset&apos;s codename.</li>
          <li>Reload, then search every response and WebSocket frame for it.</li>
          <li>It is in the Director&apos;s traffic, and never in the Intern&apos;s (<code>?pane=intern</code>).</li>
        </ol>
        <p className="proof-note">
          A test does exactly this on every change to the code: it records everything the Intern&apos;s browser receives and fails if any hidden
          word is in it. It is why this page doesn&apos;t name the codename: the page itself is something the Intern&apos;s browser receives.
        </p>
      </section>
    </div>
  );
}
