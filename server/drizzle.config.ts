import { defineConfig } from 'drizzle-kit';

try {
  process.loadEnvFile();
} catch {
  // no .env — defaults below match docker-compose.yml
}

const {
  DB_HOST = '127.0.0.1',
  DB_PORT = '3307',
  DB_USER = 'fs_app',
  DB_PASSWORD = 'fs_app_dev',
  DB_NAME = 'fs_internal_system',
} = process.env;

export default defineConfig({
  dialect: 'mysql',
  schema: './src/db/schema',
  out: './drizzle',
  dbCredentials: {
    url: `mysql://${DB_USER}:${DB_PASSWORD}@${DB_HOST}:${DB_PORT}/${DB_NAME}`,
  },
});
