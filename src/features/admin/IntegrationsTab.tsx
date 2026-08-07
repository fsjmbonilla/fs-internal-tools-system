import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
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
import { Textarea } from '@/components/ui/textarea';
import { ApiError, api } from '@/lib/api';

type SecretName = 'openai_api_key' | 'anthropic_api_key' | 'firebase_private_key';

interface SecretView {
  set: boolean;
  source: 'db' | 'env' | null;
}

interface IntegrationsView {
  ai: { provider: 'openai' | 'anthropic'; model: string; source: 'db' | 'env' };
  secrets: Record<SecretName, SecretView>;
  firebase: { projectId: string | null; clientEmail: string | null; source: 'db' | 'env' | null };
}

interface IntegrationsPatch {
  ai?: { provider: 'openai' | 'anthropic'; model: string } | null;
  firebase?: { projectId?: string | null; clientEmail?: string | null } | null;
  secrets?: Partial<Record<SecretName, string | null>>;
}

/** Set here / Using env / Not set — never the value; the API never returns one. */
function SecretBadge({ view }: { view: SecretView | undefined }) {
  if (view?.source === 'db') return <Badge variant="secondary">Set here</Badge>;
  if (view?.source === 'env') return <Badge variant="outline">Using env</Badge>;
  return (
    <Badge variant="outline" className="text-muted-foreground">
      Not set
    </Badge>
  );
}

export function IntegrationsTab() {
  const queryClient = useQueryClient();
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['admin', 'integrations'],
    queryFn: () => api<IntegrationsView>('/api/admin/settings/integrations'),
  });

  if (isLoading) {
    return (
      <div className="grid gap-6" aria-hidden>
        {[0, 1].map((i) => (
          <div key={i} className="h-64 animate-pulse rounded-xl bg-muted" />
        ))}
      </div>
    );
  }
  if (isError || !data) {
    return (
      <div className="grid justify-items-start gap-2">
        <p className="text-sm text-destructive">Could not load the integration settings.</p>
        <Button className="min-h-11 md:min-h-8" variant="secondary" onClick={() => void refetch()}>
          Retry
        </Button>
      </div>
    );
  }

  return (
    <div className="grid gap-6">
      <AiCard view={data} queryClient={queryClient} />
      <FirebaseCard view={data} queryClient={queryClient} />
    </div>
  );
}

/** One save mutation per card: PUT a partial patch, then refetch the view. */
function useSaveIntegrations(
  queryClient: ReturnType<typeof useQueryClient>,
  onSaved: () => void,
  setError: (message: string | null) => void,
) {
  return useMutation({
    mutationFn: (patch: IntegrationsPatch) =>
      api<IntegrationsView>('/api/admin/settings/integrations', { method: 'PUT', body: patch }),
    onSuccess: () => {
      setError(null);
      onSaved();
      void queryClient.invalidateQueries({ queryKey: ['admin', 'integrations'] });
    },
    onError: (err) =>
      setError(err instanceof ApiError ? err.message : 'Save failed — check the values and retry'),
  });
}

function AiCard({
  view,
  queryClient,
}: {
  view: IntegrationsView;
  queryClient: ReturnType<typeof useQueryClient>;
}) {
  const [provider, setProvider] = useState<'openai' | 'anthropic'>(view.ai.provider);
  const [model, setModel] = useState(view.ai.model);
  const [openaiKey, setOpenaiKey] = useState('');
  const [anthropicKey, setAnthropicKey] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setProvider(view.ai.provider);
    setModel(view.ai.model);
  }, [view.ai.provider, view.ai.model]);

  const save = useSaveIntegrations(
    queryClient,
    () => {
      // The keys are write-only; a saved key must not linger in the form.
      setOpenaiKey('');
      setAnthropicKey('');
      setSaved(true);
    },
    setError,
  );

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaved(false);
    if (!model.trim()) {
      setError('Enter a model name — the override always pins an explicit model.');
      return;
    }
    const secrets: IntegrationsPatch['secrets'] = {};
    if (openaiKey.trim()) secrets.openai_api_key = openaiKey.trim();
    if (anthropicKey.trim()) secrets.anthropic_api_key = anthropicKey.trim();
    save.mutate({
      ai: { provider, model: model.trim() },
      ...(Object.keys(secrets).length ? { secrets } : {}),
    });
  }

  function clearSecret(name: SecretName, label: string) {
    if (!confirm(`Clear the stored ${label}? Calls fall back to the server's env var.`)) return;
    setSaved(false);
    save.mutate({ secrets: { [name]: null } });
  }

  function useEnv() {
    if (!confirm('Discard the provider/model set here and use the AI_PROVIDER / AI_MODEL env vars?'))
      return;
    setSaved(false);
    save.mutate({ ai: null });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          AI provider
          {view.ai.source === 'env' && <Badge variant="outline">Using env</Badge>}
        </CardTitle>
        <CardDescription>
          Which backend answers triage, script assists and day summaries. Changes apply on the next
          AI call — no redeploy. API keys are write-only: they can be replaced or cleared, never
          read back.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="grid gap-4">
          <div className="grid gap-2 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label htmlFor="ai-provider">Provider</Label>
              <Select
                value={provider}
                onValueChange={(v) => setProvider(v as 'openai' | 'anthropic')}
              >
                <SelectTrigger id="ai-provider" className="min-h-11 md:min-h-8">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="openai">OpenAI</SelectItem>
                  <SelectItem value="anthropic">Anthropic (Claude)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="ai-model">Model</Label>
              <Input
                id="ai-model"
                className="min-h-11 md:min-h-8"
                placeholder={provider === 'openai' ? 'gpt-4.1-mini' : 'claude-opus-5'}
                value={model}
                onChange={(e) => setModel(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Must be a model of the selected provider.
              </p>
            </div>
          </div>

          <SecretField
            id="openai-key"
            label="OpenAI API key"
            view={view.secrets.openai_api_key}
            value={openaiKey}
            onChange={setOpenaiKey}
            onClear={() => clearSecret('openai_api_key', 'OpenAI API key')}
            busy={save.isPending}
          />
          <SecretField
            id="anthropic-key"
            label="Anthropic API key"
            view={view.secrets.anthropic_api_key}
            value={anthropicKey}
            onChange={setAnthropicKey}
            onClear={() => clearSecret('anthropic_api_key', 'Anthropic API key')}
            busy={save.isPending}
          />

          {error && <p className="text-sm text-destructive">{error}</p>}
          {saved && !error && (
            <p className="text-sm text-muted-foreground" role="status">
              Saved — in effect from the next AI call.
            </p>
          )}

          <div className="flex flex-wrap gap-2">
            <Button type="submit" className="min-h-11 md:min-h-8" disabled={save.isPending}>
              {save.isPending ? 'Saving…' : 'Save AI settings'}
            </Button>
            {view.ai.source === 'db' && (
              <Button
                type="button"
                variant="ghost"
                className="min-h-11 md:min-h-8"
                disabled={save.isPending}
                onClick={useEnv}
              >
                Use environment config
              </Button>
            )}
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

function FirebaseCard({
  view,
  queryClient,
}: {
  view: IntegrationsView;
  queryClient: ReturnType<typeof useQueryClient>;
}) {
  const [projectId, setProjectId] = useState(view.firebase.projectId ?? '');
  const [clientEmail, setClientEmail] = useState(view.firebase.clientEmail ?? '');
  const [privateKey, setPrivateKey] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setProjectId(view.firebase.projectId ?? '');
    setClientEmail(view.firebase.clientEmail ?? '');
  }, [view.firebase.projectId, view.firebase.clientEmail]);

  const save = useSaveIntegrations(
    queryClient,
    () => {
      setPrivateKey('');
      setSaved(true);
    },
    setError,
  );

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaved(false);
    save.mutate({
      firebase: { projectId: projectId.trim() || null, clientEmail: clientEmail.trim() || null },
      ...(privateKey.trim() ? { secrets: { firebase_private_key: privateKey.trim() } } : {}),
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          Firebase push
          {view.firebase.source === 'env' && <Badge variant="outline">Using env</Badge>}
          {view.firebase.source === null && !view.secrets.firebase_private_key.set && (
            <Badge variant="outline" className="text-muted-foreground">
              Not configured
            </Badge>
          )}
        </CardTitle>
        <CardDescription>
          Service-account credentials for push notifications (FCM). The client rebuilds with the
          new credentials on the next push — no restart. Blank fields fall back to the FIREBASE_*
          env vars.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="grid gap-4">
          <div className="grid gap-2 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label htmlFor="fb-project">Project ID</Label>
              <Input
                id="fb-project"
                className="min-h-11 md:min-h-8"
                placeholder="my-firebase-project"
                value={projectId}
                onChange={(e) => setProjectId(e.target.value)}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="fb-email">Client email</Label>
              <Input
                id="fb-email"
                className="min-h-11 md:min-h-8"
                placeholder="firebase-adminsdk@…iam.gserviceaccount.com"
                value={clientEmail}
                onChange={(e) => setClientEmail(e.target.value)}
              />
            </div>
          </div>

          <div className="grid gap-1.5">
            <div className="flex items-center gap-2">
              <Label htmlFor="fb-key">Private key</Label>
              <SecretBadge view={view.secrets.firebase_private_key} />
              {view.secrets.firebase_private_key.source === 'db' && (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="min-h-11 md:min-h-7"
                  disabled={save.isPending}
                  onClick={() => {
                    if (
                      confirm(
                        "Clear the stored Firebase private key? Push falls back to the server's env var.",
                      )
                    ) {
                      setSaved(false);
                      save.mutate({ secrets: { firebase_private_key: null } });
                    }
                  }}
                >
                  Clear
                </Button>
              )}
            </div>
            <Textarea
              id="fb-key"
              rows={4}
              className="font-mono text-xs"
              placeholder={
                view.secrets.firebase_private_key.set
                  ? 'Paste a new key to replace the current one'
                  : '-----BEGIN PRIVATE KEY-----'
              }
              value={privateKey}
              onChange={(e) => setPrivateKey(e.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
            <p className="text-xs text-muted-foreground">
              Write-only: stored encrypted and never shown again. Leave blank to keep the current
              key.
            </p>
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}
          {saved && !error && (
            <p className="text-sm text-muted-foreground" role="status">
              Saved — in effect from the next push notification.
            </p>
          )}

          <div>
            <Button type="submit" className="min-h-11 md:min-h-8" disabled={save.isPending}>
              {save.isPending ? 'Saving…' : 'Save Firebase settings'}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

function SecretField({
  id,
  label,
  view,
  value,
  onChange,
  onClear,
  busy,
}: {
  id: string;
  label: string;
  view: SecretView | undefined;
  value: string;
  onChange: (v: string) => void;
  onClear: () => void;
  busy: boolean;
}) {
  return (
    <div className="grid gap-1.5">
      <div className="flex items-center gap-2">
        <Label htmlFor={id}>{label}</Label>
        <SecretBadge view={view} />
        {view?.source === 'db' && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="min-h-11 md:min-h-7"
            disabled={busy}
            onClick={onClear}
          >
            Clear
          </Button>
        )}
      </div>
      <Input
        id={id}
        type="password"
        className="min-h-11 md:min-h-8"
        placeholder={view?.set ? 'Enter a new key to replace the current one' : 'Enter an API key'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoComplete="new-password"
        spellCheck={false}
      />
    </div>
  );
}
