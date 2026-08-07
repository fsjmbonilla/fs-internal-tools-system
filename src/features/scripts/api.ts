import { api } from '@/lib/api';
import type { Scope } from '@shared/scopes';

// The scope vocabulary, imported from the API rather than mirrored. Adding a
// scope is now one edit in one file instead of two that drift.
export { SCOPES, type Scope } from '@shared/scopes';

export interface Script {
  id: number;
  name: string;
  description: string | null;
  language: 'python';
  source: string;
  scopes: Scope[];
  createdBy: number;
  updatedBy: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface ScriptRun {
  id: number;
  scriptId: number;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'timeout';
  triggeredBy: number;
  exitCode: number | null;
  stdout: string | null;
  stderr: string | null;
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
}

export const listScripts = () => api<{ scripts: Script[] }>('/api/scripts');

export const createScript = (body: {
  name: string;
  description?: string;
  source: string;
  scopes: Scope[];
}) => api<{ script: Script }>('/api/scripts', { method: 'POST', body });

export const updateScript = (
  id: number,
  body: Partial<{ name: string; description: string; source: string; scopes: Scope[] }>,
) => api<{ script: Script }>(`/api/scripts/${id}`, { method: 'PATCH', body });

export const deleteScript = (id: number) => api(`/api/scripts/${id}`, { method: 'DELETE' });

/** 202 — queued, not run. The runner picks it up within a poll interval. */
export const runScript = (id: number) =>
  api<{ run: ScriptRun }>(`/api/scripts/${id}/run`, { method: 'POST' });

export const listRuns = (id: number) => api<{ runs: ScriptRun[] }>(`/api/scripts/${id}/runs`);

export type AssistMode = 'analyze' | 'generate' | 'edit';

/** Ask the AI about a script. `revisedSource` comes back only for mode 'edit',
 * and only when the reply carried a complete ```python fence. */
export const assistScript = (body: { source: string; instruction: string; mode: AssistMode }) =>
  api<{ reply: string; revisedSource: string | null }>('/api/scripts/assist', {
    method: 'POST',
    body,
  });

/** The scripts documentation is a Google Doc — the app stores only the pointer. */
export const getScriptsDocUrl = () => api<{ url: string | null }>('/api/admin/settings/scripts-doc-url');

export const setScriptsDocUrl = (url: string | null) =>
  api<{ url: string | null }>('/api/admin/settings/scripts-doc-url', { method: 'PUT', body: { url } });
