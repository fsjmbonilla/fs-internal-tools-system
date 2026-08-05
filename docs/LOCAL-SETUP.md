# Local setup on a fresh machine

Everything in git transfers by cloning. The only things that don't are `server/.env` (secrets,
gitignored) and generated artifacts (`node_modules/`, `dist/`, native build output) — all of which
you recreate below.

Reference versions from the original dev machine: Node **v26.5.1**, npm **12.x**, MariaDB **10.x**
(the `mysql` client reports 8.4-compatible). Any recent Node 22+ should work.

## 1. Clone and install

```bash
git clone https://github.com/fsjmbonilla/fs-internal-tools-system.git
cd fs-internal-tools-system
npm install            # frontend (repo root)
cd server && npm install && cd ..
```

## 2. Database (local dev runs on MariaDB, not MySQL)

Local dev deliberately uses the system MariaDB. This is safe because the codebase only uses
Drizzle's **core query builder** — never the relational API (`db.query.*`), which emits
`LEFT JOIN LATERAL` and breaks on MariaDB. Production is MySQL 8+.

```bash
sudo systemctl enable --now mariadb

sudo mysql -e "
CREATE DATABASE IF NOT EXISTS fs_internal_system;
CREATE DATABASE IF NOT EXISTS fs_internal_system_test;
CREATE USER IF NOT EXISTS 'fs_app'@'localhost' IDENTIFIED BY 'fs_app_dev';
GRANT ALL PRIVILEGES ON fs_internal_system.*      TO 'fs_app'@'localhost';
GRANT ALL PRIVILEGES ON fs_internal_system_test.* TO 'fs_app'@'localhost';
FLUSH PRIVILEGES;"
```

## 3. `server/.env`

Create `server/.env` with the following. The DB/JWT values below are the dev defaults and are safe
to reuse locally; the two AI values are the only real secrets.

```ini
NODE_ENV=development
PORT=4000
CORS_ORIGIN=http://localhost:5173,http://localhost:3000

# System MariaDB (no local MySQL install) — port 3306. Prod is MySQL 8+.
DB_HOST=127.0.0.1
DB_PORT=3306
DB_USER=fs_app
DB_PASSWORD=fs_app_dev
DB_NAME=fs_internal_system

JWT_SECRET=dev-secret-change-me-not-for-prod
ACCESS_TTL_SEC=900
REFRESH_TTL_DAYS=30

# Phase 7 AI support intake. Unset = intake silently no-ops and chat still works.
OPENAI_API_KEY=<your OpenAI key>
AI_MODEL=gpt-5-nano
```

All variables are declared in `server/src/config.ts` as a zod schema that **fails fast** on a bad
config, so a typo surfaces at boot rather than at runtime. Optional integrations you can leave
unset until their phase is live:

| Variable(s) | Phase | Behaviour when unset |
| --- | --- | --- |
| `MEMCACHED_SERVERS` | 2 | Caching no-ops |
| `STORAGE_DRIVER` / `S3_BUCKET` / `AWS_REGION` | 4 | Defaults to local disk (`server/uploads/`) |
| `FIREBASE_PROJECT_ID` / `_CLIENT_EMAIL` / `_PRIVATE_KEY` | 5 | Push no-ops |
| `LIVEKIT_URL` / `_API_KEY` / `_API_SECRET` | 6 | `POST /api/calls` returns 503 `calls_not_configured` |
| `OPENAI_API_KEY` / `AI_MODEL` / `SUPPORT_DEBOUNCE_MS` | 7 | AI intake no-ops; chat unaffected |

## 4. Migrate and seed

```bash
cd server
npm run db:migrate
npm run seed:admin -- you@flowerstore.ph <password-min-12-chars>
npm run seed:bot        # FS Assistant bot user, required for Phase 7 AI intake
```

Registration is restricted to allow-listed company domains (flowerstore.ph, potico.ph,
potico.co.th), configurable by an admin in the app.

## 5. Run

```bash
# from the repo root — serves dist/ on :3000 and the API on :4000
npm run build
npx pm2 start ecosystem.config.cjs
npx pm2 ls
```

PM2's process list occasionally empties between sessions (daemon state loss); re-run
`npx pm2 start ecosystem.config.cjs` **from the repo root**, not `server/`. For frontend iteration,
`npm run dev` (Vite on :5173) is faster than rebuilding.

## 6. Verify

```bash
cd server && npm test          # vitest + supertest against fs_internal_system_test
cd .. && npm run build && npm run lint
curl -s http://localhost:4000/health   # {"status":"ok","db":"up"}
```

One test is **expected to fail**: `settingsService.test.ts`'s case-insensitivity assertion, a
pre-existing JSON-column serialization bug unrelated to any recent phase. Everything else should be
green (146 tests as of Phase 7).

## Optional: LiveKit for Phase 6 calls

```bash
curl -sSL https://get.livekit.io | bash
livekit-server --dev     # binds 127.0.0.1:7880, dev creds devkey/secret
```

Then set `LIVEKIT_URL=ws://127.0.0.1:7880`, `LIVEKIT_API_KEY=devkey`,
`LIVEKIT_API_SECRET=secret` and restart the server.

## Mobile (iOS/Android)

`android/` and `ios/` are committed but their build output is not. `npm run sync` runs
`npm run build && cap sync`. Device work needs Xcode / Android Studio, neither of which was
available on the original dev machine — so all mobile-specific verification (webview auth, touch
drag, real-device push, in-call camera/mic) remains **unverified** and is the first thing to check
if you now have that access.

## Where to pick up

Read [PHASE7-PENDING-FIXES.md](PHASE7-PENDING-FIXES.md). Phase 7 is implemented on branch
`phase-7-ai-support` but **must not be merged** until its two Critical issues are fixed.
