import { type InfiniteData, useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { onNewMessage, onReaction } from '@/lib/socket';
import { getMessages, markRead } from './api';
import { MessageItem } from './MessageItem';
import type { Message } from './types';

interface MessagesPage {
  messages: Message[];
}

export function MessageList({ channelId }: { channelId: number }) {
  const queryClient = useQueryClient();
  // Highest message id already reported as read, so a re-render does not re-POST.
  const lastMarked = useRef<number>(0);

  const { data, fetchNextPage, hasNextPage, isFetchingNextPage, isLoading } = useInfiniteQuery({
    queryKey: ['messages', channelId],
    queryFn: ({ pageParam }) => getMessages(channelId, pageParam),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (lastPage) =>
      lastPage.messages.length === 50
        ? lastPage.messages[lastPage.messages.length - 1].id
        : undefined,
  });

  useEffect(() => {
    const offNew = onNewMessage((m) => {
      if (m.channelId !== channelId) return;
      queryClient.setQueryData<InfiniteData<MessagesPage, number | undefined>>(['messages', channelId], (old) => {
        if (!old) return old;
        const pages = [...old.pages];
        pages[0] = { messages: [m, ...pages[0].messages] };
        return { ...old, pages };
      });
    });
    const offReaction = onReaction((e) => {
      queryClient.setQueryData<InfiniteData<MessagesPage, number | undefined>>(['messages', channelId], (old) => {
        if (!old) return old;
        const pages = old.pages.map((p) => ({
          messages: p.messages.map((m) => {
            if (m.id !== e.messageId) return m;
            const reactions = [...m.reactions];
            const idx = reactions.findIndex((r) => r.emoji === e.emoji);
            if (e.added) {
              if (idx === -1) reactions.push({ emoji: e.emoji, userIds: [e.userId] });
              else reactions[idx] = { ...reactions[idx], userIds: [...reactions[idx].userIds, e.userId] };
            } else if (idx !== -1) {
              const userIds = reactions[idx].userIds.filter((id) => id !== e.userId);
              if (userIds.length === 0) reactions.splice(idx, 1);
              else reactions[idx] = { ...reactions[idx], userIds };
            }
            return { ...m, reactions };
          }),
        }));
        return { ...old, pages };
      });
    });
    return () => {
      offNew();
      offReaction();
    };
  }, [channelId, queryClient]);

  // A different channel has its own watermark; keeping the old one would skip
  // marking the new channel read.
  useEffect(() => {
    lastMarked.current = 0;
  }, [channelId]);

  const messages = data?.pages.flatMap((p) => p.messages) ?? [];
  // messages arrive newest-first per page; reverse for top-to-bottom display
  const ordered = [...messages].reverse();

  // Reading a channel has to advance last_read_message_id, or the unread badge
  // never clears: markRead existed in the API layer but nothing ever called it,
  // so the count stayed on a channel you were looking at.
  const newestId = messages.length > 0 ? Math.max(...messages.map((m) => m.id)) : null;
  useEffect(() => {
    // Re-runs as new messages arrive too, so the badge does not pop back up
    // while the channel is open in front of you.
    if (newestId === null || newestId <= lastMarked.current) return;
    lastMarked.current = newestId;
    markRead(channelId, newestId)
      .then(() => {
        // The sidebar reads both of these; without invalidating, the badge would
        // linger until the next 15s poll.
        void queryClient.invalidateQueries({ queryKey: ['channels'] });
        void queryClient.invalidateQueries({ queryKey: ['dms'] });
      })
      .catch(() => {
        // Non-critical: allow a retry on the next message rather than wedging.
        lastMarked.current = 0;
      });
  }, [channelId, newestId, queryClient]);

  function removeMessage(id: number) {
    queryClient.setQueryData<InfiniteData<MessagesPage, number | undefined>>(['messages', channelId], (old) => {
      if (!old) return old;
      return { ...old, pages: old.pages.map((p) => ({ messages: p.messages.filter((m) => m.id !== id) })) };
    });
  }

  if (isLoading) {
    return (
      <div className="flex h-full flex-col justify-end gap-4 overflow-hidden p-4">
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} className="flex animate-pulse gap-3">
            <div className="size-8 shrink-0 rounded-full bg-muted" />
            <div className="flex-1 space-y-2">
              <div className="h-3 w-32 rounded bg-muted" />
              <div className={`h-3 rounded bg-muted ${i % 2 ? 'w-3/4' : 'w-1/2'}`} />
            </div>
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col-reverse overflow-y-auto">
      <div>
        {ordered.map((m) => (
          <MessageItem key={m.id} message={m} onDeleted={removeMessage} />
        ))}
        {hasNextPage && (
          <button
            type="button"
            className="mx-auto my-2 block text-xs text-muted-foreground underline"
            disabled={isFetchingNextPage}
            onClick={() => fetchNextPage()}
          >
            {isFetchingNextPage ? 'Loading…' : 'Load older messages'}
          </button>
        )}
      </div>
    </div>
  );
}
