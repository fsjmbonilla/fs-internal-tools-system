# FS Internal Tools System

An internal collaboration platform: team chat and DMs, projects with kanban
boards, project docs, personal notes, and file attachments — plus an admin
surface for users, departments and registration policy.

Runs as a web app and, through Capacitor, as an iOS/Android app from the same
codebase.

## Layout

| Path | What it is |
|---|---|
| `src/` | React 19 SPA — Vite, react-router, TanStack Query, Tailwind + shadcn, zustand |
| `src/features/*` | One folder per feature: `auth`, `admin`, `chat`, `projects`, `kanban`, `docs`, `notes`, `files` |
| `src/lib/` | `api.ts` (fetch + token refresh), `socket.ts`, `uploads.ts`, `storage.ts` (token storage) |
| `server/` | Express 5 + Socket.IO API, Drizzle ORM on MySQL 8 |
| `server/src/routes/` | HTTP surface — thin, and where authorization lives |
| `server/src/services/` | Business logic; a `*.test.ts` sits next to each |
| `server/src/storage/` | `StorageDriver` — local disk in dev, S3 in production |
| `server/drizzle/` | Migrations, `0000_baseline` onward |
| `android/`, `ios/` | Capacitor native shells |
| `docs/superpowers/plans/` | The phase plans this was built from — the real design record |

## Local setup

Needs Node 22+ and MySQL 8 (MariaDB is fine for dev). Either use the compose
file:

```bash
docker compose -f docker-compose.dev.yml up -d     # mysql + memcached
```

…or point `server/.env` at a MySQL you already run. Then:

```bash
# 1. databases and a user (dev credentials, matching server/.env.example)
mysql -uroot <<'SQL'
CREATE DATABASE IF NOT EXISTS fs_internal_system CHARACTER SET utf8mb4;
CREATE DATABASE IF NOT EXISTS fs_internal_system_test CHARACTER SET utf8mb4;
CREATE USER IF NOT EXISTS 'fs_app'@'127.0.0.1' IDENTIFIED BY 'fs_app_dev';
GRANT ALL ON fs_internal_system.* TO 'fs_app'@'127.0.0.1';
GRANT ALL ON fs_internal_system_test.* TO 'fs_app'@'127.0.0.1';
SQL

# 2. server
cd server
cp .env.example .env
npm ci
npm run db:migrate
SEED_ADMIN_PASSWORD='choose-something-long' npm run seed:admin -- you@flowerstore.ph "Your Name"
npm run dev                      # API on :4000

# 3. web (separate shell, from the repo root)
npm ci
npm run dev                      # SPA on :5173
```

The SPA talks to `http://localhost:4000` directly; override with
`VITE_SERVER_URL`. Registration is restricted to the domains in the
`allowed_domains` setting (`flowerstore.ph`, `potico.ph`, `potico.co.th` by
default), which an admin can edit under `/admin`.

## Commands

```bash
# web (repo root)
npm run dev            # Vite dev server
npm run build          # tsc -b && vite build
npm run lint           # oxlint
npm run sync           # build + cap sync (native)
npm run android|ios    # sync + open the native project

# server
npm run dev            # tsx watch
npm run build          # tsc
npm start              # node dist/index.js
npm test               # vitest — uses fs_internal_system_test and truncates it
npm run db:generate    # drizzle-kit: new migration from schema changes
npm run db:migrate     # apply migrations
npm run seed:admin     # create or promote an admin
```

## Configuration

`server/src/config.ts` is the source of truth — it validates the environment
with zod and **refuses to boot** on anything invalid, including a production
start still carrying the development `JWT_SECRET`.

| Variable | Default | Notes |
|---|---|---|
| `PORT` | `4000` | |
| `CORS_ORIGIN` | `http://localhost:5173,http://localhost:3000` | Comma-separated |
| `DB_HOST` / `DB_PORT` / `DB_USER` / `DB_PASSWORD` / `DB_NAME` | `127.0.0.1` / `3306` / `fs_app` / `fs_app_dev` / `fs_internal_system` | |
| `JWT_SECRET` | dev value | Must be set in production |
| `ACCESS_TTL_SEC` / `REFRESH_TTL_DAYS` | `900` / `30` | |
| `TRUST_PROXY` | on when `NODE_ENV=production` | Required behind a load balancer, or every client shares one rate-limit bucket |
| `STORAGE_DRIVER` | `local` | `local` or `s3` |
| `UPLOAD_DIR` | `./uploads` | Local driver only |
| `S3_BUCKET` / `AWS_REGION` | — / `us-east-1` | S3 driver |
| `MEMCACHED_SERVERS` | unset | Unset means the cache layer no-ops |
| `SEED_ADMIN_PASSWORD` | — | Used by `seed:admin`, so the password stays out of shell history |

## How authorization works

Two rules run through the whole codebase. Both are load-bearing — read them
before adding a route.

**1. Invisible means 404, never 403.** If you cannot see something, the API
behaves as though it does not exist. A 403 would confirm that a private channel
or project is real, and that is itself a leak. This holds for channels,
projects, notes, DMs, files and the whole admin surface — a non-admin hitting
`/api/admin/*` gets 404.

The one deliberate exception: a project you *can* see but are not a member of
returns **403** on mutation. You have already been told it exists, so there is
nothing left to hide. Reads stay open; writes need membership.

**2. Files inherit their parent's visibility.** An attachment has no permissions
of its own: `GET /api/files/:id` resolves the message, task or doc it is linked
to and applies that parent's rule.

Sessions are a 15-minute access token plus a 30-day refresh token, rotated on
every use. Reusing a rotated refresh token revokes the entire family — that is
the stolen-token defense, so do not "simplify" it into a no-op. Socket
connections are authorized at handshake and then closed when the token expires;
losing access to a channel, or being deactivated or demoted, is pushed to live
sockets instead of waiting for a reconnect.

## Security notes

- **Uploads are verified against their bytes**, not the client's declared MIME
  type, and only images and PDFs are ever served inline — everything else
  downloads, with `nosniff` and a sandbox CSP.
- **Bearer tokens are redacted** from the request log. If you add a log site
  that could carry headers or credentials, extend `REDACTED_PATHS` in
  `server/src/logger.ts`.
- **Known and accepted:** on web the refresh token lives in `localStorage`, so
  an XSS would expose a 30-day credential. Mitigating factors: the only HTML
  render path (`src/features/docs/Markdown.tsx`) runs `rehype-sanitize`, there is
  no `dangerouslySetInnerHTML` anywhere in `src/`, and uploads can no longer pose
  as HTML. Native is unaffected — Capacitor `Preferences` uses the Keychain /
  EncryptedSharedPreferences. Moving web to an `httpOnly` cookie needs the SPA
  and API on one origin first (a Vite `/api` dev proxy); see Task A6 in
  `docs/superpowers/plans/2026-08-05-phase5-hardening-optimization.md`.
  *(Reviewed 2026-08-05.)*

## Deployment

`ecosystem.config.cjs` runs two PM2 apps: the built SPA on `:3000` and the API
on `:4000`. `server/Dockerfile` builds the API.

Two things to get right:

- **Serve the SPA and its assets from nginx or CloudFront**, with gzip/brotli.
  `pm2 serve` is fine for a smoke test, not for production assets. The API
  compresses its own JSON responses.
- **The attachment GC runs in every process.** It takes a MySQL advisory lock, so
  extra instances skip the round rather than racing — do not remove that lock
  when scaling out.

## Testing

`cd server && npm test` runs the suite against `fs_internal_system_test`, which
it truncates between tests (including clearing stored uploads — test runs used to
leave their files on disk). Suites run sequentially because they share that
database.

One thing worth knowing about the layout: per-feature suites only exercise their
own routes, and two real bugs once lived in the seams *between* features. That is
what `server/src/routes/crossFeature.test.ts` is for — notes → projects, DMs →
users. Add to it when a change spans two features.
