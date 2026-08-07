import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft } from 'lucide-react';
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
import {
  draftGmailReply,
  forwardGmail,
  getGmailMessage,
  listGmail,
  replyGmail,
  saveGmailDraft,
  sendGmail,
} from './api';
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
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState<string | undefined>(undefined);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [composeOpen, setComposeOpen] = useState(false);

  const { data, error, isLoading } = useQuery({
    queryKey: ['gmail-messages', query],
    queryFn: () => listGmail({ q: query }),
    retry: (count, err) => !isGoogleConnectionError(err) && count < 2,
  });

  /** Opening a message marks it read — reflect that in the list immediately. */
  function openMessageId(id: string) {
    setSelectedId(id);
    queryClient.setQueriesData<{ messages: Array<{ id: string; unread: boolean }> }>(
      { queryKey: ['gmail-messages'] },
      (old) =>
        old && {
          ...old,
          messages: old.messages.map((m) => (m.id === id ? { ...m, unread: false } : m)),
        },
    );
  }

  const { data: openMessage, isLoading: messageLoading } = useQuery({
    queryKey: ['gmail-message', selectedId],
    queryFn: () => getGmailMessage(selectedId!),
    enabled: selectedId !== null,
    // The server serves bodies from its permanent cache (a Gmail message is
    // immutable), so re-opening a message within the session shouldn't even
    // cost the round trip.
    staleTime: Infinity,
  });

  if (error && isGoogleConnectionError(error)) return <ConnectGooglePrompt error={error} />;

  const message = openMessage?.message;

  return (
    <div className="flex h-full">
      {/* List pane: full-width on phones, hidden there once a message is open. */}
      <div
        className={`w-full flex-col border-r md:flex md:w-96 ${
          selectedId ? 'hidden' : 'flex'
        }`}
      >
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
          <Button size="sm" className="min-h-11 md:min-h-0" onClick={() => setComposeOpen(true)}>
            Compose
          </Button>
        </div>
        <div className="flex-1 overflow-y-auto">
          {isLoading && <MessageListSkeleton />}
          {!isLoading && (data?.messages.length ?? 0) === 0 && (
            <p className="p-3 text-sm text-muted-foreground">
              {query
                ? 'No mail matches that search.'
                : 'Inbox zero — nothing to read. Compose to start a thread.'}
            </p>
          )}
          {data?.messages.map((m) => (
            <button
              key={m.id}
              type="button"
              onClick={() => openMessageId(m.id)}
              className={`block min-h-11 w-full border-b px-3 py-2 text-left transition-colors hover:bg-accent ${
                selectedId === m.id ? 'bg-accent font-medium' : ''
              }`}
            >
              <div className="flex items-baseline justify-between gap-2">
                <span className={`truncate text-sm ${m.unread ? 'font-semibold' : ''}`}>
                  {m.from.replace(/<.*>/, '').trim() || m.from}
                </span>
                <span className="shrink-0 text-xs text-muted-foreground">{fmtDate(m.date)}</span>
              </div>
              <p className={`truncate text-sm ${m.unread ? 'font-medium' : ''}`}>{m.subject}</p>
              <p className="truncate text-xs font-normal text-muted-foreground">{m.snippet}</p>
            </button>
          ))}
        </div>
      </div>

      {/* Reading pane: on phones it replaces the list and slides in. */}
      <div
        className={`flex-1 overflow-y-auto p-4 max-md:animate-in max-md:slide-in-from-right max-md:duration-200 md:block md:p-6 ${
          selectedId ? 'block' : 'hidden'
        }`}
      >
        <Button
          variant="ghost"
          size="sm"
          className="mb-2 -ml-2 min-h-11 md:hidden"
          onClick={() => setSelectedId(null)}
        >
          <ChevronLeft />
          Inbox
        </Button>
        {!selectedId && (
          <p className="text-sm text-muted-foreground">Select a message to read it.</p>
        )}
        {selectedId && messageLoading && (
          <div className="animate-pulse space-y-3">
            <div className="h-6 w-2/3 rounded bg-muted" />
            <div className="h-4 w-1/2 rounded bg-muted" />
            <div className="h-4 w-full rounded bg-muted" />
            <div className="h-4 w-full rounded bg-muted" />
            <div className="h-4 w-3/4 rounded bg-muted" />
          </div>
        )}
        {message && (
          <article className="animate-in fade-in duration-200">
            <h2 className="text-lg font-semibold">{message.subject || '(no subject)'}</h2>
            <p className="mb-4 text-sm text-muted-foreground">
              {message.from} → {message.to} · {new Date(message.date).toLocaleString()}
            </p>
            {message.bodyHtml ? (
              <EmailFrame html={message.bodyHtml} title={message.subject || 'Email'} />
            ) : (
              <pre className="whitespace-pre-wrap font-sans text-sm">
                {message.bodyText ?? message.snippet}
              </pre>
            )}
            <ReplyBox key={message.id} messageId={message.id} from={message.from} />
          </article>
        )}
      </div>

      <ComposeDialog open={composeOpen} onOpenChange={setComposeOpen} />
    </div>
  );
}

/** Skeleton shaped like the message list while the inbox loads. */
function MessageListSkeleton() {
  return (
    <div className="animate-pulse">
      {Array.from({ length: 6 }, (_, i) => (
        <div key={i} className="space-y-2 border-b px-3 py-2.5">
          <div className="flex items-baseline justify-between gap-2">
            <div className="h-3.5 w-28 rounded bg-muted" />
            <div className="h-3 w-10 rounded bg-muted" />
          </div>
          <div className="h-3.5 w-3/4 rounded bg-muted" />
          <div className="h-3 w-full rounded bg-muted" />
        </div>
      ))}
    </div>
  );
}

/**
 * Full-fidelity email rendering, safely: the (server-sanitized) HTML runs in a
 * sandboxed iframe — no allow-scripts, so nothing executes even if something
 * slipped the sanitizer, and the email's CSS cannot leak into the app. Links
 * escape via allow-popups; height follows the content (allow-same-origin is
 * safe here because scripts stay disabled).
 */
function EmailFrame({ html, title }: { html: string; title: string }) {
  const [height, setHeight] = useState(480);
  const srcDoc = `<!doctype html><html><head><meta charset="utf-8"><style>
    body { margin: 8px; font: 14px/1.45 system-ui, sans-serif; color: #111; background: #fff; }
    img { max-width: 100%; height: auto; }
  </style></head><body>${html}</body></html>`;
  return (
    <iframe
      title={title}
      srcDoc={srcDoc}
      sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
      className="w-full rounded-lg border bg-white"
      style={{ height }}
      onLoad={(e) => {
        const doc = e.currentTarget.contentDocument;
        if (doc) setHeight(Math.min(Math.max(doc.body.scrollHeight + 24, 160), 4000));
      }}
    />
  );
}

type ReplyMode = 'reply' | 'replyAll' | 'forward';

/** Reply/Reply all land in the thread (headers derive server-side); Forward quotes to a new address. */
function ReplyBox({ messageId, from }: { messageId: string; from: string }) {
  const [mode, setMode] = useState<ReplyMode>('reply');
  const [body, setBody] = useState('');
  const [forwardTo, setForwardTo] = useState('');
  const [sentAck, setSentAck] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const send = useMutation({
    mutationFn: () =>
      mode === 'forward'
        ? forwardGmail(messageId, forwardTo.trim(), body || undefined)
        : replyGmail(messageId, body, mode === 'replyAll'),
    onSuccess: () => {
      setSentAck(mode === 'forward' ? `Forwarded to ${forwardTo.trim()}.` : 'Reply sent.');
      setBody('');
      setForwardTo('');
      setError(null);
    },
    onError: (err) => setError(err instanceof Error ? err.message : 'Could not send'),
  });

  const saveDraftMut = useMutation({
    mutationFn: () => saveGmailDraft({ body, replyToMessageId: messageId }),
    onSuccess: () => {
      setSentAck('Draft saved to Gmail.');
      setError(null);
    },
    onError: (err) => setError(err instanceof Error ? err.message : 'Could not save draft'),
  });

  const aiDraft = useMutation({
    mutationFn: () => draftGmailReply(messageId, body.trim() || undefined),
    onSuccess: (res) => {
      // Whatever was typed becomes the guidance; the suggestion replaces it,
      // still fully editable before send.
      setBody(res.draft);
      setSentAck(null);
      setError(null);
    },
    onError: (err) => setError(err instanceof Error ? err.message : 'Could not draft a reply'),
  });

  const sender = from.replace(/<.*>/, '').trim() || from;
  const modes: Array<[ReplyMode, string]> = [
    ['reply', 'Reply'],
    ['replyAll', 'Reply all'],
    ['forward', 'Forward'],
  ];

  return (
    <form
      className="mt-6 flex flex-col gap-2 border-t pt-4"
      onSubmit={(e) => {
        e.preventDefault();
        setSentAck(null);
        send.mutate();
      }}
    >
      <div className="flex gap-1">
        {modes.map(([value, label]) => (
          <button
            key={value}
            type="button"
            aria-pressed={mode === value}
            onClick={() => {
              setMode(value);
              setSentAck(null);
              setError(null);
            }}
            className={`min-h-11 rounded-md px-3 text-sm transition-colors md:min-h-7 ${
              mode === value
                ? 'bg-accent font-medium text-accent-foreground'
                : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground'
            }`}
          >
            {label}
          </button>
        ))}
      </div>
      {mode === 'forward' ? (
        <div className="flex flex-col gap-1">
          <Label htmlFor="forward-to" className="text-muted-foreground">
            Forward to
          </Label>
          <Input
            id="forward-to"
            type="email"
            required
            value={forwardTo}
            onChange={(e) => setForwardTo(e.target.value)}
            placeholder="name@example.com"
          />
        </div>
      ) : (
        <Label htmlFor="reply-body" className="text-muted-foreground">
          {mode === 'replyAll' ? `Reply to ${sender} and everyone on the thread` : `Reply to ${sender}`}
        </Label>
      )}
      <Textarea
        id="reply-body"
        rows={4}
        value={body}
        onChange={(e) => {
          setBody(e.target.value);
          setSentAck(null);
        }}
        placeholder={mode === 'forward' ? 'Add a note (optional)…' : 'Write your reply…'}
        className="text-base md:text-sm"
        required={mode !== 'forward'}
      />
      {error && <p className="text-sm text-destructive">{error}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" disabled={send.isPending} className="min-h-11 md:min-h-0">
          {send.isPending ? 'Sending…' : modes.find(([v]) => v === mode)?.[1]}
        </Button>
        {mode !== 'forward' && (
          <>
            <Button
              type="button"
              variant="outline"
              className="min-h-11 md:min-h-0"
              disabled={saveDraftMut.isPending || body.trim() === ''}
              onClick={() => saveDraftMut.mutate()}
            >
              {saveDraftMut.isPending ? 'Saving…' : 'Save draft'}
            </Button>
            <Button
              type="button"
              variant="outline"
              className="min-h-11 md:min-h-0"
              disabled={aiDraft.isPending}
              onClick={() => aiDraft.mutate()}
              title="Let AI draft a reply from this message"
            >
              {aiDraft.isPending ? 'Drafting…' : '✦ Draft with AI'}
            </Button>
          </>
        )}
        {sentAck && (
          <span className="text-sm text-muted-foreground animate-in fade-in">{sentAck}</span>
        )}
      </div>
    </form>
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

  const [draftAck, setDraftAck] = useState<string | null>(null);
  const draftSave = useMutation({
    mutationFn: () => saveGmailDraft({ to: to || undefined, subject: subject || undefined, body }),
    onSuccess: () => {
      setDraftAck('Draft saved to Gmail.');
      setError(null);
    },
    onError: (err) => setError(err instanceof Error ? err.message : 'Could not save draft'),
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
          {error && <p className="text-sm text-destructive">{error}</p>}
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" className="min-h-11 md:min-h-0" disabled={send.isPending}>
              {send.isPending ? 'Sending…' : 'Send'}
            </Button>
            <Button
              type="button"
              variant="outline"
              className="min-h-11 md:min-h-0"
              disabled={draftSave.isPending || body.trim() === ''}
              onClick={() => draftSave.mutate()}
            >
              {draftSave.isPending ? 'Saving…' : 'Save draft'}
            </Button>
            {draftAck && (
              <span className="text-sm text-muted-foreground animate-in fade-in">{draftAck}</span>
            )}
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
