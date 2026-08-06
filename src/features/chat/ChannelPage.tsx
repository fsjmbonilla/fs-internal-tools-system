import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useParams } from 'react-router';
import { useAuthStore } from '@/features/auth/authStore';
import { CallBanner } from '@/features/calls/CallBanner';
import { CreateEventDialog } from '@/features/google/CreateEventDialog';
import { useActiveCall } from '@/features/calls/useActiveCall';
import { joinChannel, leaveChannel, onTyping } from '@/lib/socket';
import { getChannel } from './api';
import { MessageInput } from './MessageInput';
import { MessageList } from './MessageList';
import { TypingIndicator } from './TypingIndicator';

export function ChannelPage() {
  const { channelId } = useParams();
  const id = Number(channelId);
  const me = useAuthStore((s) => s.user);
  const { data } = useQuery({
    queryKey: ['channel', id],
    queryFn: () => getChannel(id),
    enabled: Number.isFinite(id),
  });
  const [typingUsers, setTypingUsers] = useState<Record<number, string>>({});
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const activeCall = useActiveCall(id);

  useEffect(() => {
    if (!Number.isFinite(id)) return;
    joinChannel(id);
    const off = onTyping((e) => {
      if (e.channelId !== id || e.userId === me?.id) return;
      setTypingUsers((prev) => {
        const next = { ...prev };
        if (e.isTyping) next[e.userId] = String(e.userId);
        else delete next[e.userId];
        return next;
      });
    });
    return () => {
      off();
      leaveChannel(id);
    };
  }, [id, me?.id]);

  if (!Number.isFinite(id)) return null;

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between border-b px-4 py-3">
        <div>
          <h2 className="font-semibold"># {data?.channel.name ?? '…'}</h2>
          {data?.channel.topic && <p className="text-xs text-muted-foreground">{data.channel.topic}</p>}
        </div>
        <button
          type="button"
          className="text-xs text-muted-foreground underline hover:text-foreground"
          onClick={() => setScheduleOpen(true)}
        >
          Schedule meeting
        </button>
      </header>
      <CreateEventDialog
        open={scheduleOpen}
        onOpenChange={setScheduleOpen}
        prefill={{
          title: `#${data?.channel.name ?? 'channel'} sync`,
          // Rooms are minted when a call starts, so the durable join link is
          // the channel itself — the call banner lives there.
          description: `Join the call from ${window.location.origin}/chat/${id} (Join call banner in the channel header).`,
          location: `${window.location.origin}/chat/${id}`,
        }}
      />
      <CallBanner channelId={id} activeCall={activeCall} />
      <div className="min-h-0 flex-1">
        <MessageList channelId={id} />
      </div>
      <TypingIndicator names={Object.values(typingUsers)} />
      <MessageInput channelId={id} onSent={() => {}} />
    </div>
  );
}
