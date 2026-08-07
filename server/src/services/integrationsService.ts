import { inArray } from 'drizzle-orm';
import { config } from '../config.js';
import { db } from '../db/index.js';
import { settings } from '../db/schema/index.js';
import { logger } from '../logger.js';
import { decryptToken, encryptToken } from './googleCrypto.js';
import {
  SECRET_NAMES,
  setIntegrationsCache,
  type AiConfig,
  type IntegrationsState,
  type SecretName,
} from './integrationsCache.js';

/**
 * Runtime integration config — the storage side.
 *
 * Rows in the existing `settings` table:
 *
 * - `integrations_ai`        → { provider, model }            (plain JSON)
 * - `integrations_firebase`  → { projectId, clientEmail }     (plain JSON)
 * - `secret_<name>`          → base64 of an AES-256-GCM blob  (see googleCrypto)
 *
 * Secrets reuse the Google-token encryption (same key, same blob layout), so a
 * database dump without GOOGLE_TOKEN_ENC_KEY yields ciphertext. They are
 * write-only towards the admin UI: the view below reports { set, source } per
 * secret and never the value.
 *
 * Every write refreshes the in-memory cache (integrationsCache), which is what
 * consumers actually read — so an admin save takes effect on the next AI call
 * or push send with no restart.
 */

const AI_KEY = 'integrations_ai';
const FIREBASE_KEY = 'integrations_firebase';
const secretKey = (name: SecretName) => `secret_${name}`;

const ALL_KEYS = [AI_KEY, FIREBASE_KEY, ...SECRET_NAMES.map(secretKey)];

interface DbState {
  ai: AiConfig | null;
  firebase: { projectId: string | null; clientEmail: string | null } | null;
  secrets: Partial<Record<SecretName, string>>;
}

async function readDbState(): Promise<DbState> {
  const rows = await db.select().from(settings).where(inArray(settings.key, ALL_KEYS));
  const byKey = new Map(rows.map((r) => [r.key, r.value]));

  const ai = (byKey.get(AI_KEY) as AiConfig | undefined) ?? null;
  const firebase =
    (byKey.get(FIREBASE_KEY) as { projectId: string | null; clientEmail: string | null } | undefined) ??
    null;

  const secrets: Partial<Record<SecretName, string>> = {};
  for (const name of SECRET_NAMES) {
    const stored = byKey.get(secretKey(name)) as string | undefined;
    if (!stored) continue;
    try {
      secrets[name] = decryptToken(Buffer.from(stored, 'base64'));
    } catch (err) {
      // Wrong key or tampered blob — treat as unset (env fallback) rather than
      // handing a consumer garbage, and say so once per load.
      logger.warn({ err, secret: name }, 'stored integration secret failed to decrypt — ignoring it');
    }
  }

  return { ai, firebase, secrets };
}

/** Load the settings rows into the cache. Called at boot and after every save. */
export async function loadIntegrations(): Promise<void> {
  const state = await readDbState();
  setIntegrationsCache(state satisfies IntegrationsState);
}

export interface SecretView {
  set: boolean;
  source: 'db' | 'env' | null;
}

export interface IntegrationsView {
  ai: { provider: 'openai' | 'anthropic'; model: string; source: 'db' | 'env' };
  secrets: Record<SecretName, SecretView>;
  firebase: { projectId: string | null; clientEmail: string | null; source: 'db' | 'env' | null };
}

const SECRET_ENV_SET: Record<SecretName, () => boolean> = {
  openai_api_key: () => Boolean(config.OPENAI_API_KEY),
  anthropic_api_key: () => Boolean(config.ANTHROPIC_API_KEY),
  firebase_private_key: () => Boolean(config.FIREBASE_PRIVATE_KEY),
};

/**
 * What the admin console sees: resolved values for the non-secret fields with
 * where they came from, and only { set, source } for secrets — never the value.
 * Reads the database (and refreshes the cache on the way), so it is always
 * authoritative even in a process that has not booted the cache.
 */
export async function getIntegrationsView(): Promise<IntegrationsView> {
  const dbState = await readDbState();
  setIntegrationsCache(dbState);

  const secrets = {} as Record<SecretName, SecretView>;
  for (const name of SECRET_NAMES) {
    if (dbState.secrets[name] !== undefined) secrets[name] = { set: true, source: 'db' };
    else if (SECRET_ENV_SET[name]()) secrets[name] = { set: true, source: 'env' };
    else secrets[name] = { set: false, source: null };
  }

  return {
    ai: {
      provider: dbState.ai?.provider ?? config.AI_PROVIDER,
      model: dbState.ai ? dbState.ai.model : (config.AI_MODEL ?? ''),
      source: dbState.ai ? 'db' : 'env',
    },
    secrets,
    firebase: {
      projectId: dbState.firebase?.projectId ?? config.FIREBASE_PROJECT_ID ?? null,
      clientEmail: dbState.firebase?.clientEmail ?? config.FIREBASE_CLIENT_EMAIL ?? null,
      source: dbState.firebase
        ? 'db'
        : config.FIREBASE_PROJECT_ID || config.FIREBASE_CLIENT_EMAIL
          ? 'env'
          : null,
    },
  };
}

export interface IntegrationsPatch {
  /** An object sets the AI config; null clears it back to the env vars. */
  ai?: AiConfig | null;
  /** Fields merge over what is stored; null on a field clears it to env. null overall clears the row. */
  firebase?: { projectId?: string | null; clientEmail?: string | null } | null;
  /** A string sets (encrypts) a secret; null clears it back to the env var. */
  secrets?: Partial<Record<SecretName, string | null>>;
}

async function upsert(key: string, value: unknown, updatedBy: number): Promise<void> {
  await db
    .insert(settings)
    .values({ key, value, updatedBy })
    .onDuplicateKeyUpdate({ set: { value, updatedBy } });
}

export async function updateIntegrations(patch: IntegrationsPatch, updatedBy: number): Promise<void> {
  if (patch.ai !== undefined) {
    if (patch.ai === null) {
      await db.delete(settings).where(inArray(settings.key, [AI_KEY]));
    } else {
      await upsert(AI_KEY, { provider: patch.ai.provider, model: patch.ai.model }, updatedBy);
    }
  }

  if (patch.firebase !== undefined) {
    if (patch.firebase === null) {
      await db.delete(settings).where(inArray(settings.key, [FIREBASE_KEY]));
    } else {
      const current = (await readDbState()).firebase;
      const merged = {
        projectId: patch.firebase.projectId !== undefined ? patch.firebase.projectId : (current?.projectId ?? null),
        clientEmail:
          patch.firebase.clientEmail !== undefined ? patch.firebase.clientEmail : (current?.clientEmail ?? null),
      };
      await upsert(FIREBASE_KEY, merged, updatedBy);
    }
  }

  for (const name of SECRET_NAMES) {
    const value = patch.secrets?.[name];
    if (value === undefined) continue;
    if (value === null) {
      await db.delete(settings).where(inArray(settings.key, [secretKey(name)]));
    } else {
      // encryptToken throws if GOOGLE_TOKEN_ENC_KEY is unset — the route gates
      // on that first so the admin gets a real answer, not a 500.
      await upsert(secretKey(name), encryptToken(value).toString('base64'), updatedBy);
    }
  }

  await loadIntegrations();
}
