import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The script runner.
 *
 * A separate process — and in production a separate container — because this is
 * the one place in the platform that executes code someone typed into a text box.
 * Everything about it is arranged so that a hostile script gets as little as
 * possible:
 *
 * - **No database credentials.** It talks only to the API, over the shared
 *   runner secret, and the API is its only permitted egress (enforced by the
 *   container's network policy, not by hope).
 * - **A fresh scratch directory per run**, deleted afterwards, so one script
 *   cannot leave anything for the next.
 * - **A hard timeout with SIGKILL.** SIGTERM is polite and a `while True:` that
 *   traps it would ignore it, so the kill is not negotiable.
 * - **A memory cap**, applied in the child before exec, so a runaway allocation
 *   dies rather than taking the host down with it.
 * - **A per-run token carrying only the script's scopes**, minted by the API and
 *   revoked the moment the run reports back.
 *
 * The script's own credentials arrive as environment variables rather than being
 * written into the scratch directory, so nothing on disk survives to be read.
 */

const API = process.env.RUNNER_API_BASE_URL ?? 'http://localhost:4000';
const RUNNER_TOKEN = process.env.RUNNER_TOKEN ?? '';
const POLL_MS = Number(process.env.RUNNER_POLL_MS ?? 2000);
const TIMEOUT_MS = Number(process.env.RUNNER_TIMEOUT_MS ?? 60_000);
const MEMORY_MB = Number(process.env.RUNNER_MEMORY_MB ?? 256);
const PYTHON = process.env.RUNNER_PYTHON ?? 'python3';
const MAX_OUTPUT = 200_000;

interface ClaimedRun {
  run: { id: number };
  script: { id: number; name: string; language: string; source: string };
  token: string;
  apiBaseUrl: string;
}

function log(message: string, extra: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ time: new Date().toISOString(), message, ...extra }));
}

async function claim(): Promise<ClaimedRun | null> {
  const res = await fetch(`${API}/api/runner/claim`, {
    method: 'POST',
    headers: { 'x-runner-token': RUNNER_TOKEN },
  });
  if (res.status === 204) return null;
  if (!res.ok) throw new Error(`claim failed: ${res.status}`);
  return (await res.json()) as ClaimedRun;
}

async function report(runId: number, body: Record<string, unknown>): Promise<void> {
  const res = await fetch(`${API}/api/runner/runs/${runId}/finish`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-runner-token': RUNNER_TOKEN },
    body: JSON.stringify(body),
  });
  if (!res.ok) log('failed to report run outcome', { runId, status: res.status });
}

/**
 * Run one script to completion, or kill it.
 *
 * Resolves rather than rejects on a non-zero exit: a script that fails is a
 * normal outcome to record, not an error for this loop to handle.
 */
async function execute(claimed: ClaimedRun): Promise<{
  status: 'succeeded' | 'failed' | 'timeout';
  exitCode: number | null;
  stdout: string;
  stderr: string;
}> {
  const dir = await mkdtemp(join(tmpdir(), `fs-run-${claimed.run.id}-`));
  const file = join(dir, 'script.py');
  await writeFile(file, claimed.script.source, 'utf8');
  // The SDK lands beside the script so `import fs_sdk` just works.
  await writeFile(join(dir, 'fs_sdk.py'), FS_SDK, 'utf8');

  return new Promise((resolve) => {
    // The memory cap goes on via `ulimit -v` in a shell wrapper, because Node
    // gives no way to set an rlimit on a child directly. `exec` replaces the
    // shell so the process the timeout kills is python itself, not a wrapper
    // that would leave the interpreter orphaned.
    //
    // Flags, and specifically NOT -I: isolated mode also drops the script's own
    // directory from sys.path, which makes `import fs_sdk` fail — the SDK sits
    // beside the script. -s (no user site-packages) and -E (ignore PYTHON* env)
    // give the isolation that was actually wanted; -B keeps .pyc files out of the
    // scratch dir, and -u leaves output unbuffered so a killed script still shows
    // what it printed.
    const command = `ulimit -v ${MEMORY_MB * 1024}; exec ${PYTHON} -B -s -E -u script.py`;
    const child = spawn('/bin/sh', ['-c', command], {
      cwd: dir,
      // A deliberately bare environment. Inheriting the runner's would hand the
      // script RUNNER_TOKEN, which is the key to every other script's run.
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        HOME: dir,
        FS_API_URL: claimed.apiBaseUrl,
        FS_TOKEN: claimed.token,
        FS_RUN_ID: String(claimed.run.id),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const capture = (chunk: Buffer, into: 'out' | 'err') => {
      const text = chunk.toString('utf8');
      if (into === 'out') {
        if (stdout.length < MAX_OUTPUT) stdout += text;
      } else if (stderr.length < MAX_OUTPUT) stderr += text;
    };
    child.stdout.on('data', (c: Buffer) => capture(c, 'out'));
    child.stderr.on('data', (c: Buffer) => capture(c, 'err'));

    const timer = setTimeout(() => {
      timedOut = true;
      // SIGKILL, not SIGTERM: a runaway loop can trap the polite one.
      child.kill('SIGKILL');
    }, TIMEOUT_MS);

    child.on('error', (err) => {
      clearTimeout(timer);
      void rm(dir, { recursive: true, force: true });
      resolve({ status: 'failed', exitCode: null, stdout, stderr: String(err) });
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      void rm(dir, { recursive: true, force: true });
      resolve({
        status: timedOut ? 'timeout' : code === 0 ? 'succeeded' : 'failed',
        exitCode: code,
        stdout,
        stderr: timedOut
          ? `${stderr}\nKilled after ${TIMEOUT_MS / 1000}s — the script exceeded its time limit.`
          : stderr,
      });
    });
  });
}

/** The Python helper every run gets, written beside the script. */
const FS_SDK = `"""fs_sdk — the platform's API, from inside a script run.

Every call carries this run's token, which holds only the scopes declared on the
script. A call outside those scopes comes back 403, and that is the point: the
scopes on the script are the truth about what it can do.

    import fs_sdk
    fs_sdk.create_ticket(project_id=1, column_id=2, title="From a script")
"""
import json
import os
import urllib.error
import urllib.request

API = os.environ.get("FS_API_URL", "http://localhost:4000")
TOKEN = os.environ.get("FS_TOKEN", "")
RUN_ID = os.environ.get("FS_RUN_ID")


class ApiError(RuntimeError):
    def __init__(self, status, body):
        super().__init__("HTTP %s: %s" % (status, body))
        self.status = status
        self.body = body


def request(method, path, body=None):
    url = API + path
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Authorization", "Bearer " + TOKEN)
    if data:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=30) as res:
            raw = res.read().decode()
            return json.loads(raw) if raw else None
    except urllib.error.HTTPError as err:
        raise ApiError(err.code, err.read().decode()) from None


def get(path):
    return request("GET", path)


def list_projects():
    return get("/api/projects")["projects"]


def get_board(project_id):
    return get("/api/projects/%d/board" % project_id)


def create_ticket(project_id, column_id, title, description=None, priority=None):
    body = {"columnId": column_id, "title": title}
    if description is not None:
        body["description"] = description
    if priority is not None:
        body["priority"] = priority
    return request("POST", "/api/projects/%d/tasks" % project_id, body)


def post_message(channel_id, text):
    return request("POST", "/api/channels/%d/messages" % channel_id, {"body": text})


def read_sheet(sheet_id):
    return get("/api/sheets/%d" % sheet_id)["sheet"]


def write_sheet(sheet_id, data):
    return request("PATCH", "/api/sheets/%d" % sheet_id, {"data": data})
`;

async function tick(): Promise<void> {
  const claimed = await claim();
  if (!claimed) return;
  log('running script', { runId: claimed.run.id, script: claimed.script.name });
  const outcome = await execute(claimed);
  log('script finished', { runId: claimed.run.id, status: outcome.status });
  await report(claimed.run.id, outcome);
}

async function main(): Promise<void> {
  if (!RUNNER_TOKEN) {
    console.error('RUNNER_TOKEN is required — refusing to start');
    process.exit(1);
  }
  log('runner started', { api: API, timeoutMs: TIMEOUT_MS, memoryMb: MEMORY_MB });

  let stopping = false;
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      log('runner stopping', { signal });
      stopping = true;
    });
  }

  while (!stopping) {
    try {
      await tick();
    } catch (err) {
      // One bad run — or a momentarily unreachable API — must not end the loop.
      // A runner that exits on error is a queue that silently stops draining.
      log('runner tick failed', { error: String(err) });
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  process.exit(0);
}

void main();
