export interface Character {
  key: 'director' | 'analyst' | 'intern' | 'liaison';
  id: string;
  name: string;
  title: string;
  role: string;
  clearance: number;
  divisionId: string | null;
  accessToken: string;
}

export interface Session {
  briefingId: string;
  expiresAt: string;
  clearances: string[];
  divisions: { id: string; name: string }[];
  characters: Character[];
}

// sessionStorage is shared by same-origin iframes in one tab, and gone when the tab closes.
const KEY = 'redacted-session';

export function loadSession(): Session | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    const session = raw ? (JSON.parse(raw) as Session) : null;
    return session && new Date(session.expiresAt) > new Date() ? session : null;
  } catch {
    return null;
  }
}

export function saveSession(session: Session): void {
  sessionStorage.setItem(KEY, JSON.stringify(session));
}

export async function startSession(): Promise<Session> {
  const res = await fetch('/demo/sessions', { method: 'POST' });
  if (!res.ok) throw new Error(res.status === 429 ? 'Too many new sessions from here: try again in a minute.' : 'Could not start the demo.');
  const session = (await res.json()) as Session;
  saveSession(session);
  return session;
}
