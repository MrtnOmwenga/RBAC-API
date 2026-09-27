export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/** Calls the API as one character. Errors carry the RFC 9457 `detail`. */
export async function api<T>(token: string, path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(path, {
    method: init.method ?? 'GET',
    headers: { authorization: `Bearer ${token}`, ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  if (!res.ok) {
    const problem = (await res.json().catch(() => ({}))) as { detail?: string };
    throw new ApiError(res.status, problem.detail ?? res.statusText);
  }
  return (res.status === 204 ? undefined : await res.json()) as T;
}

export type Access = 'none' | 'read' | 'edit';

export interface Section {
  id: string;
  position: number;
  classification: number;
  access: Access;
  heading?: string;
  redactedLength?: number;
}

export interface Briefing {
  id: string;
  title: string;
  access: Access;
  canShare: boolean;
  clearance: number;
  sections: Section[];
}

export interface Explanation {
  access: Access;
  reasons: { source: 'role' | 'share'; access: Access; because: string }[];
  clearance: string;
  redactedSections: { id: string; classification: string }[];
}

export const collabUrl = () => `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/collab`;
