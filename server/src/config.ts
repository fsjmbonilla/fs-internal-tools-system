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
  // Set when the app sits behind a proxy/load balancer that appends
  // X-Forwarded-For. Left unset it follows NODE_ENV — see the export below.
  TRUST_PROXY: z.enum(['true', 'false']).optional(),
  STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
  UPLOAD_DIR: z.string().default('./uploads'),
  S3_BUCKET: z.string().optional(),
  AWS_REGION: z.string().default('us-east-1'),
  // Push notifications: unset means pushService.ts no-ops everywhere (mirrors MEMCACHED_SERVERS).
  FIREBASE_PROJECT_ID: z.string().optional(),
  FIREBASE_CLIENT_EMAIL: z.string().optional(),
  FIREBASE_PRIVATE_KEY: z.string().optional(),
  // Teleconference: unlike push, there's no sensible offline behavior for a video
  // call — unset means /api/calls responds 503 rather than silently no-opping.
  LIVEKIT_URL: z.string().optional(),
  LIVEKIT_API_KEY: z.string().optional(),
  LIVEKIT_API_SECRET: z.string().optional(),
  // AI support intake: unset means aiService.ts returns null and supportIntake skips —
  // chat must stay fully functional without AI (fail-soft, unlike LIVEKIT's 503).
  OPENAI_API_KEY: z.string().optional(),
  AI_MODEL: z.string().default('gpt-5-nano'),
  SUPPORT_DEBOUNCE_MS: z.coerce.number().int().nonnegative().default(5000),
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
  // In production there is always a proxy in front (ALB / nginx); locally there
  // is not, and trusting a forwarded header nobody sets would let any client
  // claim any address — which is exactly what the rate limiter keys on.
  TRUST_PROXY:
    parsed.data.TRUST_PROXY !== undefined
      ? parsed.data.TRUST_PROXY === 'true'
      : parsed.data.NODE_ENV === 'production',
};
