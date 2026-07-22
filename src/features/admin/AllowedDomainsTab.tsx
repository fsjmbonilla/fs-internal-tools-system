import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { ApiError, api } from '@/lib/api';

export function AllowedDomainsTab() {
  const queryClient = useQueryClient();
  const { data } = useQuery({
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
        <div className="flex flex-wrap gap-2">
          {domains.map((d) => (
            <Badge key={d} variant="secondary" className="gap-1">
              {d}
              <button
                type="button"
                aria-label={`remove ${d}`}
                className="ml-1 opacity-60 hover:opacity-100"
                onClick={() => setDomains(domains.filter((x) => x !== d))}
              >
                ×
              </button>
            </Badge>
          ))}
        </div>
        <div className="flex gap-2">
          <Input
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
          <Button type="button" variant="secondary" onClick={addDraft}>
            Add
          </Button>
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <div>
          <Button
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
