import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { getGmailMessage, listGmail, sendGmail } from './api';
import { isGoogleConnectionError } from './api';
import { ConnectGooglePrompt } from './ConnectGooglePrompt';

function fmtDate(iso: string): string {
  const d = new Date(iso);
  const today = new Date().toDateString() === d.toDateString();
  return today
    ? d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** Inbox list + reading pane + compose. */
export function GmailPage() {
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState<string | undefined>(undefined);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [composeOpen, setComposeOpen] = useState(false);

  const { data, error, isLoading } = useQuery({
    queryKey: ['gmail-messages', query],
    queryFn: () => listGmail({ q: query }),
    retry: (count, err) => !isGoogleConnectionError(err) && count < 2,
  });

  const { data: openMessage } = useQuery({
    queryKey: ['gmail-message', selectedId],
    queryFn: () => getGmailMessage(selectedId!),
    enabled: selectedId !== null,
  });

  if (error && isGoogleConnectionError(error)) return <ConnectGooglePrompt error={error} />;

  const message = openMessage?.message;

  return (
    <div className="flex h-full">
      <div className="flex w-96 flex-col border-r">
        <div className="flex items-center gap-2 border-b p-3">
          <form
            className="flex-1"
            onSubmit={(e) => {
              e.preventDefault();
              setQuery(search || undefined);
            }}
          >
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search mail…"
            />
          </form>
          <Button size="sm" onClick={() => setComposeOpen(true)}>
            Compose
          </Button>
        </div>
        <div className="flex-1 overflow-y-auto">
          {isLoading && <p className="p-3 text-sm text-muted-foreground">Loading…</p>}
          {!isLoading && (data?.messages.length ?? 0) === 0 && (
            <p className="p-3 text-sm text-muted-foreground">
              {query ? 'No mail matches that search.' : 'Inbox zero.'}
            </p>
          )}
          {data?.messages.map((m) => (
            <button
              key={m.id}
              type="button"
              onClick={() => setSelectedId(m.id)}
              className={`block w-full border-b px-3 py-2 text-left hover:bg-accent ${
                selectedId === m.id ? 'bg-accent' : ''
              }`}
            >
              <div className="flex items-baseline justify-between gap-2">
                <span className={`truncate text-sm ${m.unread ? 'font-semibold' : ''}`}>
                  {m.from.replace(/<.*>/, '').trim() || m.from}
                </span>
                <span className="shrink-0 text-xs text-muted-foreground">{fmtDate(m.date)}</span>
              </div>
              <p className={`truncate text-sm ${m.unread ? 'font-medium' : ''}`}>{m.subject}</p>
              <p className="truncate text-xs text-muted-foreground">{m.snippet}</p>
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        {!message && (
          <p className="text-sm text-muted-foreground">Select a message to read it.</p>
        )}
        {message && (
          <article>
            <h2 className="text-lg font-semibold">{message.subject || '(no subject)'}</h2>
            <p className="mb-4 text-sm text-muted-foreground">
              {message.from} → {message.to} · {new Date(message.date).toLocaleString()}
            </p>
            {message.bodyHtml ? (
              // Sanitized server-side (strict allowlist) — see gmailService.
              // eslint-disable-next-line react/no-danger
              <div
                className="prose prose-sm max-w-none"
                dangerouslySetInnerHTML={{ __html: message.bodyHtml }}
              />
            ) : (
              <pre className="whitespace-pre-wrap font-sans text-sm">
                {message.bodyText ?? message.snippet}
              </pre>
            )}
          </article>
        )}
      </div>

      <ComposeDialog open={composeOpen} onOpenChange={setComposeOpen} />
    </div>
  );
}

function ComposeDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [to, setTo] = useState('');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [error, setError] = useState<string | null>(null);

  const send = useMutation({
    mutationFn: () => sendGmail({ to, subject, body }),
    onSuccess: () => {
      onOpenChange(false);
      setTo('');
      setSubject('');
      setBody('');
      setError(null);
    },
    onError: (err) => setError(err instanceof Error ? err.message : 'Could not send'),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New email</DialogTitle>
        </DialogHeader>
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            send.mutate();
          }}
        >
          <div className="flex flex-col gap-1">
            <Label htmlFor="mail-to">To</Label>
            <Input
              id="mail-to"
              type="email"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              required
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="mail-subject">Subject</Label>
            <Input
              id="mail-subject"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              required
              maxLength={500}
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="mail-body">Message</Label>
            <Textarea
              id="mail-body"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={8}
              required
            />
          </div>
          {error && <p className="text-sm text-red-600">{error}</p>}
          <Button type="submit" disabled={send.isPending}>
            {send.isPending ? 'Sending…' : 'Send'}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
