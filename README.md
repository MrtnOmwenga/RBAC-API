# RBAC API

[![CI](https://github.com/MrtnOmwenga/RBAC-API/actions/workflows/ci.yml/badge.svg)](https://github.com/MrtnOmwenga/RBAC-API/actions/workflows/ci.yml)
[![CodeQL](https://github.com/MrtnOmwenga/RBAC-API/actions/workflows/codeql.yml/badge.svg)](https://github.com/MrtnOmwenga/RBAC-API/actions/workflows/codeql.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A multi-tenant REST API where the access rules are the product: organizations → departments →
projects → documents, five roles with department scoping, and API keys for integrations that can
never act as people. Authorization is written once, as data, and enforced twice: in the
application, and by PostgreSQL row-level security underneath it.

NestJS 11 · TypeScript · PostgreSQL 16 (row-level security) · Kysely · zod · Argon2id · pino ·
Jest + Testcontainers · fast-check · Stryker · k6 · Docker (distroless)

## Highlights

- **Policy as data.** One table (`src/policy/policy.ts`) says which role may do what, and how far:
  anywhere in the organization, in their own department, or only on what they created. Every
  endpoint asks the same `can(principal, action, resource)`. The permission table below is
  generated from it, and CI fails if the two differ.
- **Tenant isolation the database enforces.** The API connects as a role that owns nothing. Every
  tenant table has forced row-level security keyed on a transaction-local `app.org_id`, so a query
  that forgets its `where org_id = …` still can't see or write another organization's rows.
  Composite foreign keys make cross-tenant links impossible. Tests prove this by querying
  PostgreSQL directly as that role, bypassing the application.
- **Authority comes from the database, not the token.** A JWT only says *who* the caller is. Their
  role, department and status are loaded inside the request's transaction, so a role change or a
  disabled account applies to tokens already issued, immediately.
- **Credentials that can't be confused.** Short-lived access tokens (HS256 pinned; issuer,
  audience and token type checked) in `Authorization`; API keys only in `X-API-Key`, stored as a
  prefix plus a hash of the secret. Refresh tokens rotate on every use, and replaying a spent one
  revokes the whole session family. Argon2id passwords, account lockout, a tighter rate limit on
  auth routes, and the same answer, with similar timing, for every kind of failed login.
- **A tamper-evident audit log.** Every change is recorded in the same transaction as the change,
  as a per-organization hash chain. The API's database role can insert and read it but not update
  or delete it; `GET /audit-events/verify` recomputes the chain and names the first broken event.
- **Tested like it matters.** A generated authorization matrix of 409 requests, token-forgery and
  privilege-escalation suites, property-based tests of the policy, 100% mutation score on the
  security-critical modules, and a k6 load test with a latency budget in CI.

## Permissions

`organization`: anything in the organization · `department`: only in the member's own department ·
`own`: only what they created, in their department · `·`: never. API keys hold explicit scopes,
optionally bound to one department, and can only ever be granted the actions marked below.

<!-- policy-table:start -->
| Action | `org_admin` | `department_admin` | `editor` | `viewer` | `auditor` | API key |
| --- | --- | --- | --- | --- | --- | --- |
| `department:create` | organization | · | · | · | · | · |
| `department:read` | organization | department | department | department | organization | · |
| `member:create` | organization | department | · | · | · | · |
| `member:read` | organization | department | · | · | organization | · |
| `member:update` | organization | department | · | · | · | · |
| `member:disable` | organization | department | · | · | · | · |
| `project:create` | organization | department | · | · | · | · |
| `project:read` | organization | department | department | department | organization | if scoped |
| `project:update` | organization | department | · | · | · | · |
| `project:delete` | organization | department | · | · | · | · |
| `document:create` | organization | department | department | · | · | if scoped |
| `document:read` | organization | department | department | department | organization | if scoped |
| `document:update` | organization | department | own | · | · | if scoped |
| `document:delete` | organization | department | own | · | · | · |
| `api_key:create` | organization | · | · | · | · | · |
| `api_key:read` | organization | · | · | · | organization | · |
| `api_key:revoke` | organization | · | · | · | · | · |
| `audit:read` | organization | · | · | · | organization | · |
<!-- policy-table:end -->

On top of the table: department admins may only create, change or disable editors and viewers of
their own department; nobody changes or disables their own account; and a role must match its
department (department roles need one, organization-wide roles can't have one).

## How a request is handled

```
request ─► ThrottlerGuard ─► AuthenticationGuard ─► TenantInterceptor ──────────────► controller ─► service
           (per IP; tighter     verify the JWT, or     BEGIN                                        authorize(action, resource)
            on /auth)            look up the API key    set_config('app.org_id', org, true)          query (RLS applies)
                                 by prefix and compare  load principal: role, department,            audit.record(...)
                                 its hash               scopes (disabled/revoked → 401)
                                                        … handler …
                                                        COMMIT (or ROLLBACK on any error,
                                                        audit events included)
```

- Resources from another organization are invisible under row-level security, so their IDs answer
  **404**, the same as IDs that don't exist. A resource the caller can see but not act on is **403**.
- Every error is an [RFC 9457](https://www.rfc-editor.org/rfc/rfc9457) problem document; unexpected
  errors are logged and returned as a bare 500. Request bodies are validated with zod strict
  schemas: unknown fields are a 400, which closes mass assignment.
- Logs are structured (pino), carry a request ID (`x-request-id` is accepted or generated and
  echoed), and redact credentials.

## Testing

```sh
npm test                 # unit: policy properties, audit chain, tokens, config (no database)
npm run test:e2e         # the API against real PostgreSQL (Testcontainers), in parallel
npm run test:mutation    # Stryker on the policy, tokens, audit chain and canonical JSON
k6 run load/smoke.js     # against a running stack
```

| Suite | What it proves |
|---|---|
| **Authorization matrix** (409 cases) | Eight principals (five roles, three kinds of API key) × every action × own department, other department, other organization. Expected results come from the policy, so every endpoint is shown to enforce exactly the table above. Removing a single `authorize()` call fails 13 cases. |
| **Tokens** | `alg: none`, wrong secret, edited payload, expired, wrong audience or issuer, wrong token type, tokens for unknown users or the wrong organization, keys sent as tokens and tokens as keys, revoked and expired keys: all 401. |
| **Escalation** | Mass assignment, department admins creating or promoting beyond their power or outside their department, self-promotion, API keys requesting human-only scopes or acting beyond them. |
| **Tenancy** | As the API's own database role: no rows without a tenant, only one tenant's rows with one, writes into another tenant refused, the audit log immune to UPDATE and DELETE. |
| **Audit** | The chain verifies; a row edited directly in the database is pinpointed; failed requests leave no events; 20 concurrent writes keep one linear chain. |
| **Auth flows** | Sign-up, generic login failures, lockout, refresh rotation, reuse detection revoking the family, logout, role changes and disabling applying to live tokens. |
| **Properties** (fast-check) | Nothing crosses organizations; viewers and auditors never mutate; department roles never leave their department; keys never exceed scopes; list filters agree with `can()`; role assignment never escalates. |

**Parallel and isolated.** One PostgreSQL container per run; migrations run once into a template
database, and each Jest worker clones its own copy in milliseconds. Tests create a fresh
organization for each case, so nothing needs cleaning up and nothing is shared. CI shards the e2e
suite across two runners.

**Mutation testing.** Stryker mutates the policy engine, token handling, the audit chain and
canonical JSON, and CI fails below 95%. The current score is 100%. Two mutants are marked as
equivalent in the code, each with the reason.

**Load.** `load/smoke.js` runs 20 virtual users listing, reading and editing documents for 30
seconds, and fails the run if reads exceed 100 ms p95, writes exceed 400 ms p95, or more than 1% of
requests fail. Writes get more room because writes within one organization serialize on its
audit chain: all 20 users here share one organization, the worst case. On a laptop against the Docker stack it measured about 1,100 requests per second:
reads at 27 ms p95, writes at 49 ms p95, and no errors. Every request includes row-level
security, a principal lookup and a transaction.

**CI** runs lint and type checks, unit tests, e2e shards, mutation testing, gitleaks, `npm audit`,
a Trivy scan of the image, the k6 budget, and CodeQL. Dependabot keeps dependencies current.

## Run it

```sh
# Random secrets for the local stack, kept in .env (git-ignored)
printf 'JWT_SECRET=%s\nPOSTGRES_PASSWORD=%s\nAPP_DB_PASSWORD=%s\n' \
  "$(openssl rand -hex 32)" "$(openssl rand -hex 16)" "$(openssl rand -hex 16)" > .env
docker compose up --build
```

This starts PostgreSQL, runs migrations as the owner, then starts the API on
http://localhost:3000 as the least-privilege role. The image is distroless, runs as non-root, and
the container is read-only with every capability dropped.

```sh
# Create an organization and its first admin
curl -s localhost:3000/auth/signup -H 'content-type: application/json' \
  -d '{"organization":"Acme","name":"Ada","email":"ada@example.com","password":"a long passphrase"}'

TOKEN=...   # accessToken from the response
curl -s localhost:3000/departments -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{"name":"Research"}'
curl -s localhost:3000/api-keys -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"name":"importer","scopes":["document:create","document:read"]}'
curl -s localhost:3000/audit-events/verify -H "authorization: Bearer $TOKEN"
```

For development: `npm install`, `cp .env.example .env`, `npm run migrate:dev` (with
`MIGRATION_DATABASE_URL` set), then `npm run start:dev`.

<details>
<summary>API</summary>

| | |
|---|---|
| `POST /auth/signup` · `/auth/login` · `/auth/refresh` · `/auth/logout` | sessions (public, rate-limited) |
| `GET /me` | the caller as the API sees them |
| `POST /departments` · `GET /departments` | departments |
| `POST /members` · `GET /members`, `/members/:id` · `PATCH /members/:id` · `POST /members/:id/disable` | members and roles |
| `POST /projects` · `GET /projects`, `/projects/:id` · `PATCH`, `DELETE /projects/:id` | projects |
| `POST /projects/:id/documents` · `GET /documents?projectId=`, `/documents/:id` · `PATCH`, `DELETE /documents/:id` | documents |
| `POST /api-keys` · `GET /api-keys` · `DELETE /api-keys/:id` | integration keys (the key is shown once) |
| `GET /audit-events` · `GET /audit-events/verify` | audit log and chain check |
| `GET /health/live` · `GET /health/ready` | probes |

</details>

## Design decisions

- **403 or 404?** Anything in another organization is 404: row-level security makes it invisible,
  and saying "forbidden" would confirm it exists. Inside an organization, members know what
  departments exist, so a denied action is an honest 403.
- **HS256, not RS256.** One service both issues and verifies tokens, so a shared secret is simpler
  and just as safe. With several verifying services, asymmetric keys (and a JWKS endpoint) would
  be the right call.
- **A database round trip per request** to load the principal buys immediate revocation and role
  changes. It's one primary-key lookup inside a transaction the request needs anyway.
- **Lockout versus denial of service.** Locking an account after five failures lets an attacker
  lock someone out. The lock is short (15 minutes), the auth rate limit slows guessing first, and
  the response never says an account is locked.
- **Audit appends are serialized per organization** with a transaction-scoped advisory lock, which
  keeps the chain linear under concurrency without a global lock.

## Layout

```
src/
  policy/        the permission model: pure functions over data (unit + property + mutation tested)
  auth/          sign-up, login, refresh rotation, the authentication guard and tenant interceptor
  database/      schema types, the migration (RLS, grants, lookup functions), tenant transactions
  audit/         the hash-chained audit log
  departments/ members/ projects/ documents/ api-keys/ health/
test/            e2e suites and helpers (Testcontainers, per-worker databases, seeded worlds)
load/            k6 scenario
scripts/         README permission table generator
```

## History

The first version of this repository (2024) was a small Express and MongoDB exercise. It was
rebuilt from scratch in 2026 around the ideas above; the old code is in the git history.

## License

[MIT](LICENSE)
