import type { ColumnType, Generated } from 'kysely';
import type { Action, Role } from '../policy/policy';

type CreatedAt = ColumnType<Date, never, never>;
type Timestamp = ColumnType<Date, Date | string, Date | string>;
type NullableTimestamp = ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;

export interface OrganizationsTable {
  id: string;
  name: string;
  created_at: CreatedAt;
}

export interface DepartmentsTable {
  id: Generated<string>;
  org_id: string;
  name: string;
  created_at: CreatedAt;
}

export interface UsersTable {
  id: Generated<string>;
  org_id: string;
  email: string;
  name: string;
  password_hash: string;
  role: Role;
  department_id: string | null;
  disabled_at: NullableTimestamp;
  failed_logins: Generated<number>;
  locked_until: NullableTimestamp;
  created_at: CreatedAt;
}

export interface RefreshTokensTable {
  id: Generated<string>;
  org_id: string;
  user_id: string;
  family_id: string;
  token_hash: string;
  expires_at: Timestamp;
  used_at: NullableTimestamp;
  revoked_at: NullableTimestamp;
  created_at: CreatedAt;
}

export interface ApiKeysTable {
  id: Generated<string>;
  org_id: string;
  name: string;
  prefix: string;
  secret_hash: string;
  scopes: Action[];
  department_id: string | null;
  created_by: string;
  expires_at: NullableTimestamp;
  revoked_at: NullableTimestamp;
  last_used_at: NullableTimestamp;
  created_at: CreatedAt;
}

export interface ProjectsTable {
  id: Generated<string>;
  org_id: string;
  department_id: string;
  name: string;
  created_by: string | null;
  created_at: CreatedAt;
}

export interface DocumentsTable {
  id: Generated<string>;
  org_id: string;
  project_id: string;
  department_id: string;
  title: string;
  body: string;
  author_id: string | null;
  api_key_id: string | null;
  created_at: CreatedAt;
  updated_at: Timestamp;
}

export interface AuditEventsTable {
  org_id: string;
  seq: number;
  at: Timestamp;
  actor_type: 'user' | 'integration' | 'anonymous';
  actor_id: string | null;
  action: string;
  resource_type: string;
  resource_id: string | null;
  detail: ColumnType<Record<string, unknown>, string, never>;
  prev_hash: string;
  hash: string;
}

export interface Database {
  organizations: OrganizationsTable;
  departments: DepartmentsTable;
  users: UsersTable;
  refresh_tokens: RefreshTokensTable;
  api_keys: ApiKeysTable;
  projects: ProjectsTable;
  documents: DocumentsTable;
  audit_events: AuditEventsTable;
}
