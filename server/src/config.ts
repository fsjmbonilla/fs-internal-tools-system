import { z } from 'zod';

// Load ./.env when present (dev); env vars win in prod (ECS task definition).
try {
  process.loadEnvFile();
} catch {
  // no .env file — rely on process env / defaults
}

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  CORS_ORIGIN: z.string().default('http://localhost:5173,http://localhost:3000'),
  DB_HOST: z.string().default('127.0.0.1'),
  // 3306 = the system MariaDB (per user directive — no local MySQL install); prod is MySQL 8+.
  DB_PORT: z.coerce.number().int().positive().default(3306),
  DB_USER: z.string().default('fs_app'),
  DB_PASSWORD: z.string().default('fs_app_dev'),
  DB_NAME: z.string().default('fs_internal_system'),
  JWT_SECRET: z.string().min(16).default('dev-secret-change-me-not-for-prod'),
  ACCESS_TTL_SEC: z.coerce.number().int().positive().default(900),
  REFRESH_TTL_DAYS: z.coerce.number().int().positive().default(30),
  // Opportunistic caching only — unset means cache.ts no-ops everywhere.
  MEMCACHED_SERVERS: z.string().optional(),
});

const parsed = EnvSchema.safeParse(process.env);
if (!parsed.success) {
  // Fail fast: a misconfigured server must not boot.
  console.error('Invalid environment configuration:', parsed.error.issues);
  process.exit(1);
}

if (parsed.data.NODE_ENV === 'production' && parsed.data.JWT_SECRET === 'dev-secret-change-me-not-for-prod') {
  console.error('JWT_SECRET must be set in production');
  process.exit(1);
}

export const config = {
  ...parsed.data,
  corsOrigins: parsed.data.CORS_ORIGIN.split(',').map((o) => o.trim()),
};
