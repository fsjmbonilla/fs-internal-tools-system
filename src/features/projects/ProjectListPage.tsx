import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { listProjects } from './api';
import { NewProjectDialog } from './NewProjectDialog';

export function ProjectListPage() {
  const { data } = useQuery({ queryKey: ['projects'], queryFn: listProjects });

  return (
    <main className="h-full w-full overflow-y-auto p-4 animate-in fade-in duration-150 md:p-6">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Projects</h1>
        <NewProjectDialog />
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {!data &&
          [0, 1, 2].map((i) => (
            <div key={i} className="h-16 animate-pulse rounded-xl bg-muted" />
          ))}
        {data?.projects.length === 0 && (
          <p className="text-sm text-muted-foreground">
            No projects yet — create the first one with “New project”.
          </p>
        )}
        {data?.projects.map((p) => (
          <Link key={p.id} to={`/projects/${p.id}`}>
            <Card className="transition-colors hover:bg-muted/50">
              <CardHeader>
                <CardTitle className="text-base">{p.name}</CardTitle>
              </CardHeader>
              {p.description && (
                <CardContent className="text-sm text-muted-foreground">{p.description}</CardContent>
              )}
            </Card>
          </Link>
        ))}
      </div>
    </main>
  );
}
