import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config.js';
import { AppError } from '../middleware/errorHandler.js';
import { validate } from '../middleware/validate.js';
import { claimNextRun, finishRun, getScript, mintRunToken } from '../services/scriptService.js';

/**
 * The runner's private door into the API.
 *
 * The runner is a separate container whose only permitted egress is this API —
 * it has no database credentials and no route to the internet. So claiming work
 * and reporting results happen here rather than over SQL, which keeps the number
 * of things holding database credentials to one.
 *
 * Authentication is a shared secret, not a user JWT or a service token: the
 * runner is infrastructure, not an actor. It has no identity in the product and
 * should not appear in an audit trail as one. Unset means these routes 503 —
 * a misconfigured runner must not silently authenticate as nobody.
 */
export const runnerRouter = Router();

runnerRouter.use((req, _res, next) => {
  if (!config.RUNNER_TOKEN) {
    throw new AppError(503, 'runner_disabled', 'No runner token is configured');
  }
  const presented = req.header('x-runner-token');
  // Length-independent compare is overkill for a secret this long, but the cost
  // of getting it wrong is a slow-drip oracle and the cost of doing it is nil.
  if (!presented || presented.length !== config.RUNNER_TOKEN.length) {
    throw new AppError(401, 'unauthenticated', 'Bad runner token');
  }
  let diff = 0;
  for (let i = 0; i < presented.length; i++) {
    diff |= presented.charCodeAt(i) ^ config.RUNNER_TOKEN.charCodeAt(i);
  }
  if (diff !== 0) throw new AppError(401, 'unauthenticated', 'Bad runner token');
  next();
});

/**
 * Take the next queued run.
 *
 * Returns the source to execute and a freshly minted token carrying only that
 * script's scopes. 204 when the queue is empty, so the runner's poll loop stays
 * a cheap no-op most of the time.
 */
runnerRouter.post('/claim', async (_req, res) => {
  const run = await claimNextRun();
  if (!run) {
    res.status(204).end();
    return;
  }
  const script = await getScript(run.scriptId);
  if (!script) {
    await finishRun(run.id, { status: 'failed', error: 'The script was deleted before it ran' });
    res.status(204).end();
    return;
  }

  const token = await mintRunToken(run, script);
  if (token === null) {
    await finishRun(run.id, {
      status: 'failed',
      error: 'No bot user is seeded, so no token could be minted for this run',
    });
    res.status(204).end();
    return;
  }

  res.json({
    run: { id: run.id },
    script: { id: script.id, name: script.name, language: script.language, source: script.source },
    // Shown to the runner once, exactly as a service token is shown to a person once.
    token,
    apiBaseUrl: config.RUNNER_API_BASE_URL,
  });
});

const finishBody = z.object({
  status: z.enum(['succeeded', 'failed', 'timeout']),
  exitCode: z.number().int().nullable().optional(),
  stdout: z.string().optional(),
  stderr: z.string().optional(),
  error: z.string().max(2000).optional(),
});

runnerRouter.post('/runs/:id/finish', validate(finishBody), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw new AppError(400, 'validation_error', 'Bad id');
  // finishRun revokes the run's token, so a script cannot keep using its
  // credential after reporting that it finished.
  await finishRun(id, req.valid as z.infer<typeof finishBody>);
  res.json({ ok: true });
});
