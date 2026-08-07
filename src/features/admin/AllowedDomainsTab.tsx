import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { ApiError, api } from '@/lib/api';

export function AllowedDomainsTab() {
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['admin', 'domains'],
    queryFn: () => api<{ domains: string[] }>('/api/admin/settings/allowed-domains'),
  });

  const [domains, setDomains] = useState<string[]>([]);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (data) setDomains(data.domains);
  }, [data]);

  const save = useMutation({
    mutationFn: (next: string[]) =>
      api('/api/admin/settings/allowed-domains', { method: 'PUT', body: { domains: next } }),
    onSuccess: () => {
      setError(null);
      void queryClient.invalidateQueries({ queryKey: ['admin', 'domains'] });
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Save failed'),
  });

  function addDraft() {
    const d = draft.trim().toLowerCase();
    if (d && !domains.includes(d)) setDomains([...domains, d]);
    setDraft('');
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Registration domains</CardTitle>
        <CardDescription>
          Only emails on these domains can self-register an account.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {isLoading ? (
          <div className="flex gap-2" aria-hidden>
            {[0, 1].map((i) => (
              <div key={i} className="h-6 w-32 animate-pulse rounded-full bg-muted" />
            ))}
          </div>
        ) : (
          <div className="flex flex-wrap gap-2">
            {domains.length === 0 && (
              <p className="text-sm text-muted-foreground">
                No domains yet — add one below to open registration.
              </p>
            )}
            {domains.map((d) => (
              <Badge key={d} variant="secondary" className="gap-1">
                {d}
                <button
                  type="button"
                  aria-label={`remove ${d}`}
                  className="ml-0.5 -mr-1 rounded px-1.5 py-1 opacity-60 transition-opacity hover:opacity-100"
                  onClick={() => setDomains(domains.filter((x) => x !== d))}
                >
                  ×
                </button>
              </Badge>
            ))}
          </div>
        )}
        <div className="flex gap-2">
          <Input
            className="min-h-11 md:min-h-8"
            placeholder="example.com"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                addDraft();
              }
            }}
          />
          <Button
            type="button"
            className="min-h-11 md:min-h-8"
            variant="secondary"
            onClick={addDraft}
          >
            Add
          </Button>
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <div>
          <Button
            className="min-h-11 md:min-h-8"
            disabled={save.isPending || domains.length === 0}
            onClick={() => save.mutate(domains)}
          >
            {save.isPending ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
