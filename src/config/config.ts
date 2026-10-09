import { z } from 'zod';

const base = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  DATABASE_URL: z.string().min(1),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters (openssl rand -hex 32)'),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),
  LOGIN_MAX_FAILURES: z.coerce.number().int().positive().default(5),
  LOGIN_LOCK_MINUTES: z.coerce.number().int().positive().default(15),
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(300),
  AUTH_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(10),
  // Public "Redacted" demo: anyone can create a throwaway agency, deleted after DEMO_TTL_MINUTES.
  DEMO_MODE: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  DEMO_TTL_MINUTES: z.coerce.number().int().positive().default(120),
  // How often open live connections are checked for what no announcement covers: a share or a
  // token that has run out.
  REALTIME_SWEEP_SECONDS: z.coerce.number().int().positive().default(15),
  // The built demo UI (web/dist), served from the API's own origin when present.
  WEB_DIR: z.string().default('web/dist'),
  // When set, only requests carrying it in X-Edge-Secret are served (health checks apart): the
  // reverse proxy in front sends it, so the API's own address can't be used to go around the proxy.
  EDGE_SECRET: z.string().min(32, 'EDGE_SECRET must be at least 32 characters').optional(),
  // The header the proxy puts the visitor's address in; rate limits count by it.
  CLIENT_IP_HEADER: z.string().min(1).optional(),
});

const schema = base.refine((c) => !c.CLIENT_IP_HEADER || c.EDGE_SECRET, {
  path: ['CLIENT_IP_HEADER'], message: 'needs EDGE_SECRET: without it anyone could send that header',
});

export type Config = z.infer<typeof schema>;
export const CONFIG = Symbol('CONFIG');

/** Fails fast at startup, listing every missing or invalid variable at once. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = schema.safeParse(env);
  if (!result.success) {
    const problems = result.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid configuration:\n${problems}`);
  }
  return result.data;
}
