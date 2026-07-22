import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { settings } from '../db/schema/index.js';

const KEY = 'allowed_domains';
const DEFAULTS = ['flowerstore.ph', 'potico.ph', 'potico.co.th'];

export async function getAllowedDomains(): Promise<string[]> {
  const [row] = await db.select().from(settings).where(eq(settings.key, KEY));
  return row ? (row.value as string[]) : DEFAULTS;
}

export async function setAllowedDomains(domains: string[], updatedBy: number): Promise<void> {
  const value = domains.map((d) => d.trim().toLowerCase()).filter(Boolean);
  await db
    .insert(settings)
    .values({ key: KEY, value, updatedBy })
    .onDuplicateKeyUpdate({ set: { value, updatedBy } });
}

export async function isEmailAllowed(email: string): Promise<boolean> {
  const domain = email.split('@')[1]?.toLowerCase();
  if (!domain) return false;
  return (await getAllowedDomains()).includes(domain);
}
