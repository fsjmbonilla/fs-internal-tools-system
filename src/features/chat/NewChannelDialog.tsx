import { useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { createChannel } from './api';

const ORG_WIDE = 'org';

/**
 * Create a channel from the sidebar.
 *
 * Channels are independent of projects — a fresh install has neither, and there
 * was no way to make the first channel without calling the API by hand:
 * `createChannel` existed in the API layer from the start but nothing was ever
 * wired to it.
 */
export function NewChannelDialog({
  departments,
}: {
  departments: { id: number; name: string }[];
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [topic, setTopic] = useState('');
  const [isPrivate, setIsPrivate] = useState(false);
  const [departmentId, setDepartmentId] = useState<string>(ORG_WIDE);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const { channel } = await createChannel({
        name: name.trim(),
        isPrivate,
        topic: topic.trim() || undefined,
        // Org-wide is the absence of a department, which is how the sidebar
        // decides whether a channel belongs under a department heading.
        departmentId: departmentId === ORG_WIDE ? undefined : Number(departmentId),
      });
      // The sidebar and the quick switcher both read this key.
      await queryClient.invalidateQueries({ queryKey: ['channels'] });
      setOpen(false);
      setName('');
      setTopic('');
      setIsPrivate(false);
      setDepartmentId(ORG_WIDE);
      navigate(`/chat/${channel.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create the channel');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button
          type="button"
          className="rounded p-0.5 text-sidebar-foreground/60 transition-colors hover:bg-sidebar-accent/60 hover:text-sidebar-foreground"
          aria-label="New channel"
          title="New channel"
        >
          <Plus className="size-3.5" />
        </button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create channel</DialogTitle>
        </DialogHeader>
        <div className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="channel-name">Name</Label>
            <Input
              id="channel-name"
              value={name}
              placeholder="marketing"
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && name.trim() && !busy) void submit();
              }}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="channel-topic">Topic (optional)</Label>
            <Input id="channel-topic" value={topic} onChange={(e) => setTopic(e.target.value)} />
          </div>
          {departments.length > 0 && (
            <div className="grid gap-2">
              <Label htmlFor="channel-dept">Department</Label>
              <Select value={departmentId} onValueChange={setDepartmentId}>
                <SelectTrigger id="channel-dept">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ORG_WIDE}>Org-wide</SelectItem>
                  {departments.map((d) => (
                    <SelectItem key={d.id} value={String(d.id)}>
                      {d.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={isPrivate}
              onChange={(e) => setIsPrivate(e.target.checked)}
            />
            Private (members only)
          </label>
          {error && (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          )}
          <Button disabled={!name.trim() || busy} onClick={submit}>
            {busy ? 'Creating…' : 'Create'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
