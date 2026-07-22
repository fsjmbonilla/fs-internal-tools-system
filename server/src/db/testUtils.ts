import { pool } from './index.js';

const TABLES = [
  'refresh_tokens',
  'department_members',
  'departments',
  'channel_members',
  'messages',
  'channels',
  'settings',
  'users',
];

export async function resetDb(): Promise<void> {
  await pool.query('SET FOREIGN_KEY_CHECKS = 0');
  for (const t of TABLES) await pool.query(`TRUNCATE TABLE \`${t}\``);
  await pool.query('SET FOREIGN_KEY_CHECKS = 1');
}
