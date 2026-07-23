import { Paperclip } from 'lucide-react';
import { useRef, useState } from 'react';
import { sendMessage as sendSocketMessage, startTyping, stopTyping } from '@/lib/socket';
import { uploadFiles, type UploadedFile } from '@/lib/uploads';

export function MessageInput({ channelId, onSent }: { channelId: number; onSent: () => void }) {
  const [value, setValue] = useState('');
  const [pending, setPending] = useState<UploadedFile[]>([]);
  const [uploading, setUploading] = useState(false);
  const typingTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  function handleChange(v: string) {
    setValue(v);
    startTyping(channelId);
    if (typingTimeout.current) clearTimeout(typingTimeout.current);
    typingTimeout.current = setTimeout(() => stopTyping(channelId), 3000);
  }

  async function handleFilePick(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    e.target.value = '';
    if (files.length === 0) return;
    setUploading(true);
    try {
      const uploaded = await uploadFiles(files);
      setPending((prev) => [...prev, ...uploaded]);
    } finally {
      setUploading(false);
    }
  }

  async function send() {
    const body = value.trim();
    if (!body) return;
    const attachmentIds = pending.map((f) => f.id);
    setValue('');
    setPending([]);
    if (typingTimeout.current) clearTimeout(typingTimeout.current);
    stopTyping(channelId);
    await sendSocketMessage({ channelId, body, attachmentIds: attachmentIds.length ? attachmentIds : undefined });
    onSent();
  }

  return (
    <div className="border-t p-3">
      {pending.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-2">
          {pending.map((f) => (
            <span key={f.id} className="rounded-md border px-2 py-1 text-xs">
              {f.fileName}
            </span>
          ))}
        </div>
      )}
      <div className="flex items-end gap-2">
        <button
          type="button"
          className="rounded-md p-2 text-muted-foreground hover:bg-accent disabled:opacity-50"
          disabled={uploading}
          onClick={() => fileInputRef.current?.click()}
          aria-label="Attach file"
        >
          <Paperclip className="size-4" />
        </button>
        <input ref={fileInputRef} type="file" multiple hidden onChange={handleFilePick} />
        <textarea
          className="flex-1 resize-none rounded-md border bg-background p-2 text-sm outline-none focus:ring-1 focus:ring-ring"
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
    </div>
  );
}
