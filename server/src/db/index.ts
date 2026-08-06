import { drizzle } from 'drizzle-orm/mysql2';
import mysql from 'mysql2/promise';
import { config } from '../config.js';
import * as schema from './schema/index.js';

export const pool = mysql.createPool({
  host: config.DB_HOST,
  port: config.DB_PORT,
  user: config.DB_USER,
  password: config.DB_PASSWORD,
  database: config.DB_NAME,
  connectionLimit: 10,
});

export const db = drizzle(pool, { schema, mode: 'default' });

/**
 * Either the pool or an open transaction.
 *
 * A service that takes one of these can be composed into a caller's transaction
 * without knowing it is in one. Derived from `db.transaction`'s own callback
 * parameter so it stays correct if drizzle's transaction type changes.
 */
export type Executor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];
