import { type Kysely, type Migration, sql } from 'kysely';

/*
 * The schema, with tenant isolation enforced by PostgreSQL itself:
 *
 * - The API connects as a login role that is a member of `rbac_app`, which owns nothing and has
 *   only the grants below. Every tenant table has row-level security, forced, keyed on the
 *   transaction-local setting `app.org_id`; without it set, every query sees no rows. So even a
 *   query that forgets its `where org_id = …` can't read or write another organization's data.
 * - Composite foreign keys (org_id, id) make it impossible to link rows across organizations.
 * - The audit log is append-only by privilege: `rbac_app` can insert and read it, never update or
 *   delete.
 * - Three SECURITY DEFINER functions answer the only questions asked before the organization is
 *   known (who owns this email / refresh token / API key prefix), returning the minimum needed.
 *
 * Migrations run as the database owner, which needs BYPASSRLS (the compose superuser has it).
 */

const TENANT_TABLES = ['departments', 'users', 'refresh_tokens', 'api_keys', 'projects', 'documents', 'audit_events'];

const initial: Migration = {
  async up(db: Kysely<unknown>) {
    await sql`
      do $$ begin
        if not exists (select from pg_roles where rolname = 'rbac_app') then create role rbac_app nologin; end if;
      end $$;

      create table organizations (
        id uuid primary key,
        name text not null check (length(name) between 1 and 100),
        created_at timestamptz not null default now()
      );

      create table departments (
        id uuid primary key default gen_random_uuid(),
        org_id uuid not null references organizations (id) on delete cascade,
        name text not null check (length(name) between 1 and 100),
        created_at timestamptz not null default now(),
        unique (org_id, name),
        unique (org_id, id)
      );

      create table users (
        id uuid primary key default gen_random_uuid(),
        org_id uuid not null references organizations (id) on delete cascade,
        email text not null,
        name text not null,
        password_hash text not null,
        role text not null check (role in ('org_admin', 'department_admin', 'editor', 'viewer', 'auditor')),
        department_id uuid,
        disabled_at timestamptz,
        failed_logins integer not null default 0,
        locked_until timestamptz,
        created_at timestamptz not null default now(),
        unique (org_id, id),
        foreign key (org_id, department_id) references departments (org_id, id),
        -- Department roles belong to exactly one department; organization-wide roles to none.
        check ((role in ('department_admin', 'editor', 'viewer')) = (department_id is not null))
      );
      create unique index users_email_key on users (lower(email));

      create table refresh_tokens (
        id uuid primary key default gen_random_uuid(),
        org_id uuid not null,
        user_id uuid not null,
        family_id uuid not null,
        token_hash text not null unique,
        expires_at timestamptz not null,
        used_at timestamptz,
        revoked_at timestamptz,
        created_at timestamptz not null default now(),
        foreign key (org_id, user_id) references users (org_id, id) on delete cascade
      );
      create index refresh_tokens_family on refresh_tokens (family_id);

      create table api_keys (
        id uuid primary key default gen_random_uuid(),
        org_id uuid not null references organizations (id) on delete cascade,
        name text not null check (length(name) between 1 and 100),
        prefix text not null unique,
        secret_hash text not null,
        scopes text[] not null,
        department_id uuid,
        created_by uuid not null,
        expires_at timestamptz,
        revoked_at timestamptz,
        last_used_at timestamptz,
        created_at timestamptz not null default now(),
        foreign key (org_id, department_id) references departments (org_id, id),
        foreign key (org_id, created_by) references users (org_id, id)
      );

      create table projects (
        id uuid primary key default gen_random_uuid(),
        org_id uuid not null,
        department_id uuid not null,
        name text not null check (length(name) between 1 and 200),
        created_by uuid,
        created_at timestamptz not null default now(),
        unique (org_id, id, department_id),
        foreign key (org_id, department_id) references departments (org_id, id)
      );

      create table documents (
        id uuid primary key default gen_random_uuid(),
        org_id uuid not null,
        project_id uuid not null,
        department_id uuid not null,
        title text not null check (length(title) between 1 and 200),
        body text not null,
        author_id uuid,
        api_key_id uuid,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        -- A document's department is always its project's department.
        foreign key (org_id, project_id, department_id) references projects (org_id, id, department_id) on delete cascade,
        check ((author_id is null) <> (api_key_id is null))
      );
      create index documents_project on documents (project_id);

      create table audit_events (
        org_id uuid not null references organizations (id) on delete cascade,
        seq integer not null check (seq > 0),
        at timestamptz not null,
        actor_type text not null check (actor_type in ('user', 'integration', 'anonymous')),
        actor_id uuid,
        action text not null,
        resource_type text not null,
        resource_id uuid,
        detail jsonb not null,
        prev_hash text not null,
        hash text not null,
        primary key (org_id, seq)
      );
    `.execute(db);

    await sql`
      alter table organizations enable row level security;
      alter table organizations force row level security;
      create policy tenant_isolation on organizations
        using (id = nullif(current_setting('app.org_id', true), '')::uuid)
        with check (id = nullif(current_setting('app.org_id', true), '')::uuid);
    `.execute(db);
    for (const table of TENANT_TABLES) {
      await sql`
        alter table ${sql.table(table)} enable row level security;
        alter table ${sql.table(table)} force row level security;
        create policy tenant_isolation on ${sql.table(table)}
          using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
          with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
      `.execute(db);
    }

    await sql`
      grant usage on schema public to rbac_app;
      grant select, insert on organizations, departments to rbac_app;
      grant select, insert, update on users, refresh_tokens, api_keys to rbac_app;
      grant select, insert, update, delete on projects, documents to rbac_app;
      grant select, insert on audit_events to rbac_app;

      create function auth_login_lookup(p_email text)
        returns table (id uuid, org_id uuid) language sql stable security definer set search_path = public
        as $$ select id, org_id from users where lower(email) = lower(p_email) $$;
      create function auth_refresh_lookup(p_token_hash text)
        returns table (id uuid, org_id uuid) language sql stable security definer set search_path = public
        as $$ select id, org_id from refresh_tokens where token_hash = p_token_hash $$;
      create function auth_api_key_lookup(p_prefix text)
        returns table (id uuid, org_id uuid, secret_hash text) language sql stable security definer set search_path = public
        as $$ select id, org_id, secret_hash from api_keys where prefix = p_prefix $$;
      revoke all on function auth_login_lookup(text), auth_refresh_lookup(text), auth_api_key_lookup(text) from public;
      grant execute on function auth_login_lookup(text), auth_refresh_lookup(text), auth_api_key_lookup(text) to rbac_app;
    `.execute(db);
  },
};

/*
 * Sharing, clearance and sectioned documents (the "Redacted" demo):
 * - members get a clearance level; each document section has a classification;
 * - document_grants share one document with a member or a whole department, possibly temporarily;
 * - document_sections hold each section's collaborative state (a Yjs update) and its text length,
 *   which is what a redaction bar is sized from (bucketed when served).
 * Demo organizations are marked, and a SECURITY DEFINER function deletes expired ones: the API
 * role can't delete organizations otherwise.
 */
const sharing: Migration = {
  async up(db: Kysely<unknown>) {
    await sql`
      alter table organizations add column is_demo boolean not null default false;
      -- Projects reached organizations only through departments, so deleting an organization
      -- stopped at them. They now go with it (and their documents, sections and shares with them).
      alter table projects add foreign key (org_id) references organizations (id) on delete cascade;
      alter table users add column clearance smallint not null default 0 check (clearance between 0 and 3);
      alter table documents add constraint documents_org_id_id unique (org_id, id);

      create table document_grants (
        id uuid primary key default gen_random_uuid(),
        org_id uuid not null,
        document_id uuid not null,
        subject_type text not null check (subject_type in ('user', 'department')),
        subject_id uuid not null,
        relation text not null check (relation in ('reader', 'editor')),
        granted_by uuid not null,
        expires_at timestamptz,
        created_at timestamptz not null default now(),
        unique (document_id, subject_type, subject_id),
        foreign key (org_id, document_id) references documents (org_id, id) on delete cascade,
        foreign key (org_id, granted_by) references users (org_id, id)
      );
      create index document_grants_subject on document_grants (subject_type, subject_id);

      create table document_sections (
        id uuid primary key default gen_random_uuid(),
        org_id uuid not null,
        document_id uuid not null,
        position integer not null,
        heading text not null check (length(heading) between 1 and 200),
        classification smallint not null default 0 check (classification between 0 and 3),
        state bytea not null default ''::bytea,
        text_length integer not null default 0,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        foreign key (org_id, document_id) references documents (org_id, id) on delete cascade
      );
      create index document_sections_document on document_sections (document_id, position);
    `.execute(db);
    for (const table of ['document_grants', 'document_sections']) {
      await sql`
        alter table ${sql.table(table)} enable row level security;
        alter table ${sql.table(table)} force row level security;
        create policy tenant_isolation on ${sql.table(table)}
          using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
          with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
      `.execute(db);
    }
    await sql`
      grant select, insert, update, delete on document_grants, document_sections to rbac_app;

      create function demo_cleanup(p_older_than interval)
        returns integer language sql volatile security definer set search_path = public
        as $$ with gone as (delete from organizations where is_demo and created_at < now() - p_older_than returning 1)
              select count(*)::integer from gone $$;
      revoke all on function demo_cleanup(interval) from public;
      grant execute on function demo_cleanup(interval) to rbac_app;
    `.execute(db);
  },
};

/*
 * Word-level classification: the highest level marked on any words in a section, kept up to date
 * when the section is saved. The REST API uses it to decide between the full text and a
 * projection without loading the live document.
 */
const markedWords: Migration = {
  async up(db: Kysely<unknown>) {
    await sql`
      alter table document_sections
        add column max_mark_level smallint not null default 0 check (max_mark_level between 0 and 3);
    `.execute(db);
  },
};

export const migrations: Record<string, Migration> = {
  '001_initial': initial,
  '002_sharing_and_sections': sharing,
  '003_marked_words': markedWords,
};
