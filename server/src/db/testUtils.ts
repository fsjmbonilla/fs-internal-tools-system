import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { stopMailboxPoller } from '../automations/mailboxPoller.js';
import { config } from '../config.js';
import { resetTokenTouchState } from '../services/apiTokenService.js';
import { stopAllRoutines } from '../services/routineScheduler.js';
import { resetLocks } from '../services/sheetService.js';
import { pool } from './index.js';

const TABLES = [
  'message_email_origins',
  'gmail_ingest_state',
  'google_accounts',
  'ai_usage',
  'routine_runs',
  'routines',
  'script_runs',
  'scripts',
  'sheets',
  'api_tokens',
  'refresh_tokens',
  'department_members',
  'departments',
  'attachments',
  'device_tokens',
  'message_reactions',
  'message_mentions',
  'support_configs',
  'calls',
  'channel_members',
  'messages',
  'channels',
  'task_comments',
  'tasks',
  'task_columns',
  'docs',
  'project_members',
  'projects',
  'notes',
  'settings',
  'users',
];

/**
 * Truncate the tables and clear stored uploads.
 *
 * Storage used to be left alone, so every suite that uploaded a file left its
 * bytes in `server/uploads/` forever — dozens per run, growing with each test
 * run, and enough to make any assertion about what is stored non-deterministic.
 * The same blind spot in production is what Task B1 fixes.
 */
export async function resetDb(): Promise<void> {
  await pool.query('SET FOREIGN_KEY_CHECKS = 0');
  for (const t of TABLES) await pool.query(`TRUNCATE TABLE \`${t}\``);
  await pool.query('SET FOREIGN_KEY_CHECKS = 1');
  await rm(join(config.UPLOAD_DIR, 'uploads'), { recursive: true, force: true });
  // In-memory state that outlives a truncation, so it has to be reset with it.
  resetTokenTouchState();
  // Sheet edit locks are held in memory and keyed by sheet id, which truncation
  // reuses — a stale lock would silently make the next test's sheet read-only.
  resetLocks();
  // Cron timers outlive a truncation too — a routine armed by one suite would
  // keep firing against the next suite's data. The mailbox poller is the same
  // kind of timer with the same failure mode.
  stopAllRoutines();
  stopMailboxPoller();
}
