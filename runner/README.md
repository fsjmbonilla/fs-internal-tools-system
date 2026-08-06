# Script runner

Executes user-written scripts. It is a separate service because it is the only
thing in the platform that runs code someone typed into a text box.

## What isolates a run

| Control | How |
|---|---|
| No database access | The runner holds no DB credentials. It claims work and reports results over `POST /api/runner/*`, authenticated with `RUNNER_TOKEN`. |
| No network | In production the container's only permitted egress is the API origin. **Not enforced locally** — see below. |
| Time | `RUNNER_TIMEOUT_MS` (default 60s), then **SIGKILL**. SIGTERM is polite and a runaway loop can trap it. |
| Memory | `ulimit -v` (`RUNNER_MEMORY_MB`, default 256) applied in the child before exec. |
| Filesystem | A fresh `mkdtemp` scratch dir per run, removed afterwards. |
| Credentials | A token minted for that run, carrying only the script's declared scopes, acting as the bot user, revoked when the run reports back. |
| Environment | The child gets a bare env — deliberately *not* the runner's, which holds `RUNNER_TOKEN`. |

Python runs with `-B -s -E -u`, and **not** `-I`: isolated mode also drops the
script's own directory from `sys.path`, which makes `import fs_sdk` fail.

## Egress is the one control local dev does not have

Everything above works on a developer machine except the network policy. Locally
a script *can* reach the internet. It is enforced by the deployment — a Docker
network without a default route, or an ECS security group whose only egress rule
is the API — so **verify it in the environment, not here**.

## Running it

```bash
npm run build
RUNNER_TOKEN=<same as the API's> node dist/index.js
```

`RUNNER_POLL_MS` (default 2000) controls how often it asks for work. Several
runners can run at once: claiming is a conditional UPDATE, so exactly one wins
each run.
