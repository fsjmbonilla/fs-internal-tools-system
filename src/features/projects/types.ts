export interface Project {
  id: number;
  name: string;
  description: string | null;
  isPrivate: boolean;
  departmentId: number | null;
  createdBy: number | null;
  archivedAt: string | null;
  createdAt: string;
}
