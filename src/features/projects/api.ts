import { api } from '@/lib/api';
import type { Project } from './types';

export const listProjects = () => api<{ projects: Project[] }>('/api/projects');

export const createProject = (input: {
  name: string;
  isPrivate: boolean;
  description?: string;
  departmentId?: number;
}) => api<{ project: Project }>('/api/projects', { method: 'POST', body: input });

export const getProject = (id: number) => api<{ project: Project }>(`/api/projects/${id}`);
