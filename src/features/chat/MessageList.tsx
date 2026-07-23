import { type InfiniteData, useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { onNewMessage, onReaction } from '@/lib/socket';
import { getMessages } from './api';
import { MessageItem } from './MessageItem';
import type { Message } from './types';

interface MessagesPage {
  messages: Message[];
}

export function MessageList({ channelId }: { channelId: number }) {
  const queryClient = useQueryClient();

  const { data, fetchNextPage, hasNextPage, isFetchingNextPage } = useInfiniteQuery({
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

  const messages = data?.pages.flatMap((p) => p.messages) ?? [];
  // messages arrive newest-first per page; reverse for top-to-bottom display
  const ordered = [...messages].reverse();

  function removeMessage(id: number) {
    queryClient.setQueryData<InfiniteData<MessagesPage, number | undefined>>(['messages', channelId], (old) => {
      if (!old) return old;
      return { ...old, pages: old.pages.map((p) => ({ messages: p.messages.filter((m) => m.id !== id) })) };
    });
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
