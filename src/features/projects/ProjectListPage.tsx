import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { listProjects } from './api';
import { NewProjectDialog } from './NewProjectDialog';

export function ProjectListPage() {
  const { data } = useQuery({ queryKey: ['projects'], queryFn: listProjects });

  return (
    <main className="mx-auto w-full max-w-3xl p-6">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Projects</h1>
        <NewProjectDialog />
      </div>
      <div className="grid gap-3">
        {data?.projects.map((p) => (
          <Link key={p.id} to={`/projects/${p.id}`}>
            <Card className="hover:bg-muted/50">
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
