import { api } from '@/lib/api';

/** Kept in step with SCOPES in the server's apiTokenService. */
export const SCOPES = [
  'tickets:read',
  'tickets:write',
  'chat:read',
  'chat:write',
  'docs:read',
  'docs:write',
  'sheets:read',
  'sheets:write',
] as const;

export type Scope = (typeof SCOPES)[number];

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
