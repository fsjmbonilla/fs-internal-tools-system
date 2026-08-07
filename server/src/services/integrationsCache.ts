import { config } from '../config.js';

/**
 * Runtime integration config — the read side.
 *
 * Admins can change third-party provider settings (AI provider/model, API keys,
 * Firebase credentials) at runtime without a redeploy. The values live in the
 * `settings` table (secrets encrypted at rest — see integrationsService), but
 * consumers need them synchronously and on hot paths, so this module holds a
 * process-level cache that integrationsService populates at boot and refreshes
 * on every admin save.
 *
 * Resolution order everywhere: the database value if an admin has set one,
 * otherwise the environment variable. An empty cache therefore behaves exactly
 * like the pre-feature code — which is what keeps every test that mocks
 * `config` working unchanged, and what a fresh process falls back to until the
 * boot-time load completes.
 *
 * Deliberately a leaf over `config` only: providers and pushService import
 * this, and dragging the DB pool into their unit tests (which mock config
 * wholesale) would break them.
 */

export const SECRET_NAMES = ['openai_api_key', 'anthropic_api_key', 'firebase_private_key'] as const;
export type SecretName = (typeof SECRET_NAMES)[number];

export interface AiConfig {
  provider: 'openai' | 'anthropic';
  model: string;
}

export interface IntegrationsState {
  ai: AiConfig | null;
  firebase: { projectId: string | null; clientEmail: string | null } | null;
  /** Decrypted values — held in memory exactly as env-var secrets already are. */
  secrets: Partial<Record<SecretName, string>>;
}

const EMPTY: IntegrationsState = { ai: null, firebase: null, secrets: {} };

let state: IntegrationsState = EMPTY;

export function setIntegrationsCache(next: IntegrationsState): void {
  state = next;
}

/** For resetDb(): a truncated settings table must not leave stale config behind. */
export function resetIntegrationsCache(): void {
  state = EMPTY;
}

const SECRET_ENV: Record<SecretName, () => string | undefined> = {
  openai_api_key: () => config.OPENAI_API_KEY,
  anthropic_api_key: () => config.ANTHROPIC_API_KEY,
  firebase_private_key: () => config.FIREBASE_PRIVATE_KEY,
};

/** Admin-set value if present, else the environment variable. */
export function getSecret(name: SecretName): string | undefined {
  return state.secrets[name] ?? SECRET_ENV[name]();
}

export function getAiConfig(): AiConfig {
  return {
    provider: state.ai?.provider ?? config.AI_PROVIDER,
    // '' means "the provider's own default" — same contract as AI_MODEL.
    model: state.ai?.model ?? config.AI_MODEL ?? '',
  };
}

export interface ResolvedFirebaseConfig {
  projectId: string | undefined;
  clientEmail: string | undefined;
  privateKey: string | undefined;
}

export function getFirebaseConfig(): ResolvedFirebaseConfig {
  return {
    projectId: state.firebase?.projectId ?? config.FIREBASE_PROJECT_ID,
    clientEmail: state.firebase?.clientEmail ?? config.FIREBASE_CLIENT_EMAIL,
    privateKey: getSecret('firebase_private_key'),
  };
}
