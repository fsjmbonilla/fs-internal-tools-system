import { eq } from 'drizzle-orm';
import { db, pool } from '../db/index.js';
import { users } from '../db/schema/index.js';
import { hashPassword } from '../services/passwords.js';

// Prefer the environment: an argv password lands in shell history, in `ps` output
// while the command runs, and in any CI log that echoes its commands. The
// positional form still works so existing notes and scripts do not break.
const args = process.argv.slice(2);
const envPassword = process.env.SEED_ADMIN_PASSWORD;
const email = args[0];
const password = envPassword ?? args[1];
// With the password out of argv, the name moves up a slot.
const displayName = (envPassword ? args[1] : args[2]) ?? 'Admin';

if (!email || !password || password.length < 12) {
  console.error(
    'usage: SEED_ADMIN_PASSWORD=<password (>=12 chars)> npm run seed:admin -- <email> [displayName]\n' +
      '   or: npm run seed:admin -- <email> <password (>=12 chars)> [displayName]',
  );
  process.exit(1);
}
if (!envPassword) {
  console.warn(
    'warning: a password given as an argument is recorded in your shell history — prefer SEED_ADMIN_PASSWORD',
  );
}

const passwordHash = await hashPassword(password);
const [existing] = await db
  .select({ id: users.id })
  .from(users)
  .where(eq(users.email, email.toLowerCase()));

if (existing) {
  await db
    .update(users)
    .set({ passwordHash, role: 'admin', isActive: true })
    .where(eq(users.id, existing.id));
  console.log(`promoted existing user ${email} to admin`);
} else {
  await db.insert(users).values({ email: email.toLowerCase(), passwordHash, displayName, role: 'admin' });
  console.log(`created admin ${email}`);
}
await pool.end();
