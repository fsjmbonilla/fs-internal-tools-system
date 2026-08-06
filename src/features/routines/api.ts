import { SCOPES, type Scope } from '@/features/scripts/api';
import { api } from '@/lib/api';

export { SCOPES, type Scope };

export interface Routine {
  id: number;
  name: string;
  prompt: string;
  schedule: string;
  scopes: Scope[];
  outputChannelId: number | null;
  enabled: boolean;
  ownerId: number;
  /** Computed server-side from the schedule; null when disabled. */
  nextRunAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type TranscriptEntry =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; name: string; input: unknown }
  | { type: 'tool_result'; name: string; output: unknown };

export interface RoutineRun {
  id: number;
  routineId: number;
  status: 'running' | 'succeeded' | 'failed' | 'budget_exceeded';
  trigger: 'schedule' | 'manual';
  transcript: TranscriptEntry[] | null;
  summary: string | null;
  inputTokens: number;
  outputTokens: number;
  iterations: number;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export const listRoutines = () => api<{ routines: Routine[] }>('/api/routines');

export const createRoutine = (body: {
  name: string;
  prompt: string;
  schedule: string;
  scopes: Scope[];
  outputChannelId?: number | null;
}) => api<{ routine: Routine }>('/api/routines', { method: 'POST', body });

export const updateRoutine = (id: number, body: Partial<Routine>) =>
  api<{ routine: Routine }>(`/api/routines/${id}`, { method: 'PATCH', body });

export const deleteRoutine = (id: number) => api(`/api/routines/${id}`, { method: 'DELETE' });

/** Runs synchronously — the caller is watching and wants the result. */
export const runRoutineNow = (id: number) =>
  api<{ run: RoutineRun }>(`/api/routines/${id}/run`, { method: 'POST' });

export const listRoutineRuns = (id: number) =>
  api<{ runs: RoutineRun[] }>(`/api/routines/${id}/runs`);

/**
 * A human sentence for the common schedules.
 *
 * Deliberately a small lookup rather than a cron parser: covering the handful of
 * shapes the picker offers is honest, and anything else is shown as the raw
 * expression instead of a confident wrong translation.
 */
export const SCHEDULE_PRESETS: { label: string; value: string }[] = [
  { label: 'Every minute', value: '* * * * *' },
  { label: 'Every 15 minutes', value: '*/15 * * * *' },
  { label: 'Hourly, on the hour', value: '0 * * * *' },
  { label: 'Every weekday at 08:00', value: '0 8 * * 1-5' },
  { label: 'Every day at 08:00', value: '0 8 * * *' },
  { label: 'Mondays at 09:00', value: '0 9 * * 1' },
];

export function describeSchedule(expression: string): string {
  return SCHEDULE_PRESETS.find((p) => p.value === expression)?.label ?? expression;
}
