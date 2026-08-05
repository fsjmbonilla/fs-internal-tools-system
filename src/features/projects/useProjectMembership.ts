import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';

interface ProjectResponse {
  project: { id: number; name: string; isMember: boolean };
}

/**
 * Whether the current user may change this project.
 *
 * Reading a visible project is open; every mutation requires membership (admins
 * included via the server's own flag). The UI has to know, or it renders buttons
 * that come back 403.
 *
 * Defaults to false while loading: showing a control a moment late is better
 * than showing one that fails.
 */
export function useProjectMembership(projectId: number): { canEdit: boolean; loaded: boolean } {
  const { data } = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => api<ProjectResponse>(`/api/projects/${projectId}`),
    enabled: Number.isFinite(projectId) && projectId > 0,
  });
  return { canEdit: data?.project.isMember ?? false, loaded: Boolean(data) };
}
