import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { ApiError, api } from '@/lib/api';

interface ApiToken {
  id: number;
  name: string;
  scopes: string[];
  actsAsUserId: number;
  createdBy: number;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

interface AdminUser {
  id: number;
  displayName: string;
  isBot: boolean;
  isActive: boolean;
}

function status(token: ApiToken): { label: string; variant: 'secondary' | 'destructive' } {
  if (token.revokedAt) return { label: 'Revoked', variant: 'destructive' };
  if (token.expiresAt && new Date(token.expiresAt) < new Date()) {
    return { label: 'Expired', variant: 'destructive' };
  }
  return { label: 'Active', variant: 'secondary' };
}

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : '—');

export function TokensTab() {
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['admin', 'tokens'],
    queryFn: () => api<{ tokens: ApiToken[] }>('/api/admin/tokens'),
  });
  const { data: scopeData } = useQuery({
    queryKey: ['admin', 'token-scopes'],
    queryFn: () => api<{ scopes: string[] }>('/api/admin/tokens/scopes'),
  });
  const { data: userData } = useQuery({
    queryKey: ['admin', 'users'],
    queryFn: () => api<{ users: AdminUser[] }>('/api/admin/users'),
  });

  // Only bots can hold a token, so only bots are offered. The server validates
  // this too — the filter here is to keep the operator from trying.
  const bots = (userData?.users ?? []).filter((u) => u.isBot && u.isActive);
  const nameOf = (id: number) =>
    userData?.users.find((u) => u.id === id)?.displayName ?? `user ${id}`;

  const [name, setName] = useState('');
  const [actsAs, setActsAs] = useState('');
  const [scopes, setScopes] = useState<string[]>([]);
  const [expiresAt, setExpiresAt] = useState('');
  const [error, setError] = useState<string | null>(null);
  /** Shown once, then gone — there is no endpoint that could show it again. */
  const [issued, setIssued] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () =>
      api<{ id: number; token: string }>('/api/admin/tokens', {
        method: 'POST',
        body: {
          name: name.trim(),
          scopes,
          actsAsUserId: Number(actsAs),
          ...(expiresAt ? { expiresAt: new Date(expiresAt).toISOString() } : {}),
        },
      }),
    onSuccess: (result) => {
      setError(null);
      setIssued(result.token);
      setName('');
      setScopes([]);
      setExpiresAt('');
      void queryClient.invalidateQueries({ queryKey: ['admin', 'tokens'] });
    },
    onError: (err) =>
      setError(err instanceof ApiError ? err.message : 'Could not create the token'),
  });

  const revoke = useMutation({
    mutationFn: (id: number) => api(`/api/admin/tokens/${id}`, { method: 'DELETE' }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['admin', 'tokens'] }),
  });

  function toggleScope(scope: string) {
    setScopes((current) =>
      current.includes(scope) ? current.filter((s) => s !== scope) : [...current, scope],
    );
  }

  const canCreate = name.trim().length > 0 && actsAs !== '' && scopes.length > 0;

  return (
    <div className="grid gap-6">
      <Card>
        <CardHeader>
          <CardTitle>New service token</CardTitle>
          <CardDescription>
            A token lets an AI agent or automation use this platform as a bot user. It sees only
            what that bot is a member of, every write is attributed to it, and it can never reach
            anyone's notes.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          <div className="grid gap-2 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label htmlFor="token-name">Name</Label>
              <Input
                id="token-name"
                className="min-h-11 md:min-h-8"
                placeholder="Claude Code (ops laptop)"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="token-bot">Acts as</Label>
              <Select value={actsAs} onValueChange={setActsAs}>
                <SelectTrigger id="token-bot" className="min-h-11 md:min-h-8">
                  <SelectValue placeholder={bots.length ? 'Choose a bot user' : 'No bot user yet'} />
                </SelectTrigger>
                <SelectContent>
                  {bots.map((bot) => (
                    <SelectItem key={bot.id} value={String(bot.id)}>
                      {bot.displayName}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {bots.length === 0 && (
                <p className="text-xs text-muted-foreground">
                  Seed one first: <code>npm run seed:bot</code>
                </p>
              )}
            </div>
          </div>

          <div className="grid gap-1.5">
            <Label>Scopes</Label>
            <div className="flex flex-wrap gap-2">
              {(scopeData?.scopes ?? []).map((scope) => (
                <Button
                  key={scope}
                  type="button"
                  size="sm"
                  className="min-h-11 md:min-h-7"
                  variant={scopes.includes(scope) ? 'default' : 'outline'}
                  aria-pressed={scopes.includes(scope)}
                  onClick={() => toggleScope(scope)}
                >
                  {scope}
                </Button>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">
              Grant the narrowest set that does the job. There is deliberately no scope for notes.
            </p>
          </div>

          <div className="grid gap-1.5 sm:max-w-xs">
            <Label htmlFor="token-expiry">Expires (optional)</Label>
            <Input
              id="token-expiry"
              className="min-h-11 md:min-h-8"
              type="date"
              value={expiresAt}
              onChange={(e) => setExpiresAt(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              An expiry is the cheapest way to bound a leak.
            </p>
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}

          <div>
            <Button
              className="min-h-11 md:min-h-8"
              disabled={!canCreate || create.isPending}
              onClick={() => create.mutate()}
            >
              {create.isPending ? 'Creating…' : 'Create token'}
            </Button>
          </div>
        </CardContent>
      </Card>

      {issued && (
        <Card className="animate-in border-primary duration-150 fade-in">
          <CardHeader>
            <CardTitle>Copy this token now</CardTitle>
            <CardDescription>
              This is the only time it is shown. Nothing stored here can reproduce it — if it is
              lost, revoke it and create another.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3">
            <code className="block overflow-x-auto rounded bg-muted p-3 font-mono text-sm">
              {issued}
            </code>
            <div className="flex gap-2">
              <Button
                type="button"
                className="min-h-11 md:min-h-8"
                variant="secondary"
                onClick={() => void navigator.clipboard?.writeText(issued)}
              >
                Copy
              </Button>
              <Button
                type="button"
                className="min-h-11 md:min-h-8"
                variant="ghost"
                onClick={() => setIssued(null)}
              >
                I've saved it
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Tokens</CardTitle>
          <CardDescription>
            Revoked tokens stay listed — the row is the record of what the token could do.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="grid gap-2" aria-hidden>
              {[0, 1, 2].map((i) => (
                <div key={i} className="h-11 animate-pulse rounded bg-muted" />
              ))}
            </div>
          ) : (
            /* Table ships its own overflow-x-auto container — wide rows scroll here, not the page. */
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Acts as</TableHead>
                  <TableHead>Scopes</TableHead>
                  <TableHead>Last used</TableHead>
                  <TableHead>Expires</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {(data?.tokens ?? []).map((token) => {
                  const state = status(token);
                  return (
                    <TableRow key={token.id}>
                      <TableCell className="font-medium">{token.name}</TableCell>
                      <TableCell>{nameOf(token.actsAsUserId)}</TableCell>
                      <TableCell>
                        <div className="flex flex-wrap gap-1">
                          {token.scopes.map((scope) => (
                            <Badge key={scope} variant="outline" className="font-mono text-xs">
                              {scope}
                            </Badge>
                          ))}
                        </div>
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {when(token.lastUsedAt)}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {when(token.expiresAt)}
                      </TableCell>
                      <TableCell>
                        <Badge variant={state.variant}>{state.label}</Badge>
                      </TableCell>
                      <TableCell className="text-right">
                        {!token.revokedAt && (
                          <Button
                            type="button"
                            size="sm"
                            className="min-h-11 md:min-h-7"
                            variant="ghost"
                            disabled={revoke.isPending}
                            onClick={() => {
                              if (confirm(`Revoke "${token.name}"?`)) revoke.mutate(token.id);
                            }}
                          >
                            {revoke.isPending && revoke.variables === token.id
                              ? 'Revoking…'
                              : 'Revoke'}
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
                {data?.tokens.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={7} className="text-center text-muted-foreground">
                      No service tokens yet — create one with the form above.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
