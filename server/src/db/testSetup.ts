import { drizzle } from 'drizzle-orm/mysql2';
import { migrate } from 'drizzle-orm/mysql2/migrator';
import mysql from 'mysql2/promise';

// vitest globalSetup: bring the dedicated test database up to date.
export default async function setup(): Promise<void> {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST ?? '127.0.0.1',
    port: Number(process.env.DB_PORT ?? 3306),
    user: process.env.DB_USER ?? 'fs_app',
    password: process.env.DB_PASSWORD ?? 'fs_app_dev',
    database: 'fs_internal_system_test',
    multipleStatements: true,
  });
  await migrate(drizzle(conn), { migrationsFolder: './drizzle' });
  await conn.end();
}
