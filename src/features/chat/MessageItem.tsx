import { useAuthStore } from '@/features/auth/authStore';
import { AttachmentChip } from '@/features/files/AttachmentChip';
import { sendReaction } from '@/lib/socket';
import { deleteMessageRest } from './api';
import type { Message } from './types';

export function MessageItem({
  message,
  onDeleted,
}: {
  message: Message;
  onDeleted: (id: number) => void;
}) {
  const me = useAuthStore((s) => s.user);
  const isAuthor = me?.id === message.userId;

  return (
    <div className="group flex gap-3 px-4 py-1.5 hover:bg-muted/50">
      <div className="flex-1">
        <div className="flex items-baseline gap-2">
          <span className="font-semibold">{message.displayName}</span>
          <span className="text-xs text-muted-foreground">
            {new Date(message.createdAt).toLocaleTimeString([], {
              hour: '2-digit',
              minute: '2-digit',
            })}
          </span>
          {message.editedAt && <span className="text-xs text-muted-foreground">(edited)</span>}
        </div>
        <p className="whitespace-pre-wrap text-sm">{message.body}</p>
        {message.attachments.length > 0 && (
          <div className="mt-1 flex flex-wrap gap-1">
            {message.attachments.map((a) => (
              <AttachmentChip key={a.id} attachment={a} />
            ))}
          </div>
        )}
        {message.reactions.length > 0 && (
          <div className="mt-1 flex gap-1">
            {message.reactions.map((r) => (
              <button
                key={r.emoji}
                type="button"
                className="rounded-full border px-2 py-0.5 text-xs hover:bg-accent"
                onClick={() => sendReaction(message.id, message.channelId, r.emoji)}
              >
                {r.emoji} {r.userIds.length}
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="hidden gap-1 group-hover:flex">
        <button
          type="button"
          className="text-xs text-muted-foreground hover:text-foreground"
          onClick={() => sendReaction(message.id, message.channelId, '👍')}
        >
          👍
        </button>
        {isAuthor && (
          <button
            type="button"
            className="text-xs text-muted-foreground hover:text-destructive"
            onClick={async () => {
              await deleteMessageRest(message.id);
              onDeleted(message.id);
            }}
          >
            Delete
          </button>
        )}
      </div>
    </div>
  );
}
