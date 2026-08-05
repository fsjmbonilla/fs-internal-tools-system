import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '../config.js';
import { resetTokenTouchState } from '../services/apiTokenService.js';
import { pool } from './index.js';

const TABLES = [
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
}
