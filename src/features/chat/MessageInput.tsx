import { useRef, useState } from 'react';
import { sendMessage as sendSocketMessage, startTyping, stopTyping } from '@/lib/socket';

export function MessageInput({ channelId, onSent }: { channelId: number; onSent: () => void }) {
  const [value, setValue] = useState('');
  const typingTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  function handleChange(v: string) {
    setValue(v);
    startTyping(channelId);
    if (typingTimeout.current) clearTimeout(typingTimeout.current);
    typingTimeout.current = setTimeout(() => stopTyping(channelId), 3000);
  }

  async function send() {
    const body = value.trim();
    if (!body) return;
    setValue('');
    if (typingTimeout.current) clearTimeout(typingTimeout.current);
    stopTyping(channelId);
    await sendSocketMessage({ channelId, body });
    onSent();
  }

  return (
    <div className="border-t p-3">
      <textarea
        className="w-full resize-none rounded-md border bg-background p-2 text-sm outline-none focus:ring-1 focus:ring-ring"
        rows={2}
        value={value}
        placeholder="Message…"
        onChange={(e) => handleChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            void send();
          }
        }}
      />
    </div>
  );
}
