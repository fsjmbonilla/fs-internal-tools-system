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

const SCRIPTS_DOC_KEY = 'scripts_doc_url';

/**
 * The scripts documentation is maintained as a Google Doc/Drive folder, not
 * in-app content — this setting is just the pointer to it.
 */
export async function getScriptsDocUrl(): Promise<string | null> {
  const [row] = await db.select().from(settings).where(eq(settings.key, SCRIPTS_DOC_KEY));
  return row ? (row.value as string | null) : null;
}

export async function setScriptsDocUrl(url: string | null, updatedBy: number): Promise<void> {
  if (url === null) {
    // settings.value is NOT NULL — "no docs link" is the absence of the row.
    await db.delete(settings).where(eq(settings.key, SCRIPTS_DOC_KEY));
    return;
  }
  await db
    .insert(settings)
    .values({ key: SCRIPTS_DOC_KEY, value: url, updatedBy })
    .onDuplicateKeyUpdate({ set: { value: url, updatedBy } });
}

export async function isEmailAllowed(email: string): Promise<boolean> {
  const domain = email.split('@')[1]?.toLowerCase();
  if (!domain) return false;
  return (await getAllowedDomains()).includes(domain);
}
