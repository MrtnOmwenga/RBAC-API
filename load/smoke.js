// k6 load test: a signed-in member reading and editing documents.
//   k6 run load/smoke.js            (against http://localhost:3000)
// Fails if p95 latency or the error rate exceed the budgets below.
import http from 'k6/http';
import { check } from 'k6';

const BASE = __ENV.BASE_URL || 'http://localhost:3000';
const json = (token) => ({ headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) } });

export const options = {
  scenarios: { members: { executor: 'constant-vus', vus: 20, duration: '30s' } },
  thresholds: {
    'http_req_duration{kind:read}': ['p(95)<100'],
    // Writes in one organization serialize on its audit chain (by design), so they queue under load.
    'http_req_duration{kind:write}': ['p(95)<400'],
    http_req_failed: ['rate<0.01'],
  },
};

export function setup() {
  const email = `load-${Date.now()}@example.test`;
  const signup = http.post(`${BASE}/auth/signup`, JSON.stringify({ organization: 'Load', name: 'Load', email, password: 'load test password' }), json());
  const token = signup.json('accessToken');
  const dept = http.post(`${BASE}/departments`, JSON.stringify({ name: 'Load' }), json(token)).json('id');
  const project = http.post(`${BASE}/projects`, JSON.stringify({ name: 'Load', departmentId: dept }), json(token)).json('id');
  const documents = [];
  for (let i = 0; i < 20; i += 1) {
    documents.push(http.post(`${BASE}/projects/${project}/documents`, JSON.stringify({ title: `Doc ${i}` }), json(token)).json('id'));
  }
  return { token, documents };
}

export default function ({ token, documents }) {
  const id = documents[Math.floor(Math.random() * documents.length)];
  const params = json(token);
  check(http.get(`${BASE}/documents`, { ...params, tags: { kind: 'read' } }), { list: (r) => r.status === 200 });
  check(http.get(`${BASE}/documents/${id}`, { ...params, tags: { kind: 'read' } }), { read: (r) => r.status === 200 });
  if (Math.random() < 0.2) {
    check(http.patch(`${BASE}/documents/${id}`, JSON.stringify({ title: `Edited ${Date.now()}` }), { ...params, tags: { kind: 'write' } }), { write: (r) => r.status === 200 });
  }
}
