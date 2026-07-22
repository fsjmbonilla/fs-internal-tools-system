import { eq } from 'drizzle-orm';
import { db, pool } from '../db/index.js';
import { users } from '../db/schema/index.js';
import { hashPassword } from '../services/passwords.js';

const [email, password, displayName = 'Admin'] = process.argv.slice(2);
if (!email || !password || password.length < 12) {
  console.error('usage: npm run seed:admin -- <email> <password (>=12 chars)> [displayName]');
  process.exit(1);
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
