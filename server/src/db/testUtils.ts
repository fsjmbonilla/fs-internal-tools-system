import { pool } from './index.js';

const TABLES = [
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

export async function resetDb(): Promise<void> {
  await pool.query('SET FOREIGN_KEY_CHECKS = 0');
  for (const t of TABLES) await pool.query(`TRUNCATE TABLE \`${t}\``);
  await pool.query('SET FOREIGN_KEY_CHECKS = 1');
}
