import { randomBytes, randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { type Kysely, sql } from 'kysely';
import { AuditService } from '../audit/audit.service';
import { hashPassword } from '../auth/passwords';
import { signAccessToken } from '../auth/tokens';
import { CONFIG, type Config } from '../config/config';
import type { Database } from '../database/schema';
import { DB, withTenant } from '../database/tenant';
import { CLEARANCES, type Role } from '../policy/policy';
import { NIGHTJAR, sectionState } from './briefing';

interface Character {
  key: 'director' | 'analyst' | 'intern' | 'liaison';
  name: string;
  title: string;
  role: Role;
  division: 'Operations' | 'Intelligence' | null;
  clearance: number;
}

/*
 * The cast of the demo. Each visitor gets a private agency, so nobody sees anyone else's changes,
 * and it is deleted after DEMO_TTL_MINUTES. The characters are ordinary members: every effect in
 * the demo comes from the real API and the real policy.
 */
const CAST: Character[] = [
  { key: 'director', name: 'M. Vance', title: 'Director', role: 'org_admin', division: null, clearance: 3 },
  { key: 'analyst', name: 'R. Okoye', title: 'Analyst, Operations', role: 'editor', division: 'Operations', clearance: 2 },
  { key: 'intern', name: 'J. Park', title: 'Intern, Operations', role: 'viewer', division: 'Operations', clearance: 0 },
  { key: 'liaison', name: 'S. Laurent', title: 'Liaison, Intelligence', role: 'editor', division: 'Intelligence', clearance: 3 },
];

@Injectable()
export class DemoService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('Demo');
  private timer?: NodeJS.Timeout;

  constructor(
    @Inject(DB) private readonly db: Kysely<Database>,
    @Inject(CONFIG) private readonly config: Config,
    private readonly audit: AuditService,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.config.DEMO_MODE) return;
    this.timer = setInterval(() => { void this.cleanup(); }, 5 * 60_000);
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    clearInterval(this.timer);
  }

  async cleanup(): Promise<number> {
    try {
      const { rows } = await sql<{ demo_cleanup: number }>`select demo_cleanup(${`${this.config.DEMO_TTL_MINUTES} minutes`}::interval)`.execute(this.db);
      return rows[0]?.demo_cleanup ?? 0;
    } catch (err) {
      this.logger.warn(`demo cleanup failed: ${err instanceof Error ? err.message : String(err)}`);
      return 0;
    }
  }

  async create() {
    const orgId = randomUUID();
    const ttlSeconds = this.config.DEMO_TTL_MINUTES * 60;
    // Nobody logs in with a password: characters get tokens. The hash is of a random secret.
    const unusable = await hashPassword(randomBytes(32).toString('hex'));
    return withTenant(this.db, orgId, async (trx) => {
      await trx.insertInto('organizations').values({ id: orgId, name: `Demo agency ${orgId.slice(0, 8)}`, is_demo: true }).execute();
      const divisions: Record<string, string> = {};
      for (const name of ['Operations', 'Intelligence']) {
        divisions[name] = (await trx.insertInto('departments').values({ org_id: orgId, name }).returning('id').executeTakeFirstOrThrow()).id;
      }
      const ids: Record<string, string> = {};
      for (const c of CAST) {
        ids[c.key] = (await trx.insertInto('users').values({
          org_id: orgId, email: `${c.key}-${orgId}@demo.invalid`, name: c.name, password_hash: unusable,
          role: c.role, department_id: c.division ? divisions[c.division]! : null, clearance: c.clearance,
        }).returning('id').executeTakeFirstOrThrow()).id;
      }
      const project = await trx.insertInto('projects').values({ org_id: orgId, department_id: divisions.Operations!, name: 'NIGHTJAR', created_by: ids.director! })
        .returning('id').executeTakeFirstOrThrow();
      const document = await trx.insertInto('documents').values({
        org_id: orgId, project_id: project.id, department_id: divisions.Operations!, title: NIGHTJAR.title, body: '',
        author_id: ids.analyst!, api_key_id: null, updated_at: new Date(),
      }).returning('id').executeTakeFirstOrThrow();
      for (const [i, s] of NIGHTJAR.sections.entries()) {
        const { state, length } = sectionState(s.text);
        await trx.insertInto('document_sections').values({
          org_id: orgId, document_id: document.id, position: i + 1, heading: s.heading, classification: s.classification,
          state, text_length: length, updated_at: new Date(),
        }).execute();
      }
      await this.audit.record(trx, orgId, { actorType: 'user', actorId: ids.director! }, { action: 'organization.create', resourceType: 'organization', resourceId: orgId, detail: { demo: true } });
      return {
        briefingId: document.id,
        expiresAt: new Date(Date.now() + ttlSeconds * 1000),
        clearances: CLEARANCES,
        divisions: Object.entries(divisions).map(([name, id]) => ({ id, name })),
        characters: CAST.map((c) => ({
          key: c.key, id: ids[c.key]!, name: c.name, title: c.title, role: c.role, clearance: c.clearance,
          divisionId: c.division ? divisions[c.division]! : null,
          accessToken: signAccessToken(this.config.JWT_SECRET, ttlSeconds, { userId: ids[c.key]!, orgId }),
        })),
      };
    });
  }
}
