import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router';
import { ScrollArea } from '@/components/ui/scroll-area';
import { logoutUser } from '@/features/auth/api';
import { useAuthStore } from '@/features/auth/authStore';
import { api } from '@/lib/api';
import { listChannels } from './api';
import type { Channel } from './types';

interface Department {
  id: number;
  name: string;
}

export function Sidebar() {
  const navigate = useNavigate();
  const user = useAuthStore((s) => s.user);
  const { channelId } = useParams();
  const { data: channelData } = useQuery({
    queryKey: ['channels'],
    queryFn: listChannels,
    refetchInterval: 15_000,
  });
  const { data: deptData } = useQuery({
    queryKey: ['departments'],
    queryFn: () => api<{ departments: Department[] }>('/api/departments'),
  });

  const channels = channelData?.channels ?? [];
  const departments = deptData?.departments ?? [];
  const grouped = departments.map((d) => ({
    dept: d,
    channels: channels.filter((c) => c.departmentId === d.id),
  }));
  const orgWide = channels.filter((c) => c.departmentId === null && c.type !== 'dm');

  return (
    <aside className="flex h-dvh w-64 flex-col bg-[#3f0e40] text-white">
      <div className="border-b border-white/10 p-4 font-semibold">FS Internal System</div>
      <ScrollArea className="flex-1 px-2 py-2">
        <Link to="/projects" className="mb-1 block rounded px-2 py-1 text-sm text-white/80 hover:bg-white/10">
          Projects
        </Link>
        <Link to="/notes" className="mb-4 block rounded px-2 py-1 text-sm text-white/80 hover:bg-white/10">
          Notes
        </Link>
        <SidebarSection title="Channels">
          {orgWide.map((c) => (
            <ChannelLink key={c.id} channel={c} active={String(c.id) === channelId} />
          ))}
        </SidebarSection>
        {grouped.map(({ dept, channels: deptChannels }) => (
          <SidebarSection key={dept.id} title={dept.name}>
            {deptChannels.map((c) => (
              <ChannelLink key={c.id} channel={c} active={String(c.id) === channelId} />
            ))}
          </SidebarSection>
        ))}
      </ScrollArea>
      <div className="flex items-center justify-between border-t border-white/10 p-3 text-sm">
        <div className="flex flex-col">
          <span>{user?.displayName}</span>
          {user?.role === 'admin' && (
            <Link to="/admin" className="text-xs text-white/60 underline">
              Administration
            </Link>
          )}
        </div>
        <button
          type="button"
          className="text-xs text-white/60 underline hover:text-white"
          onClick={async () => {
            await logoutUser();
            navigate('/login');
          }}
        >
          Sign out
        </button>
      </div>
    </aside>
  );
}

function SidebarSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-4">
      <div className="px-2 py-1 text-xs font-semibold uppercase tracking-wide text-white/50">
        {title}
      </div>
      {children}
    </div>
  );
}

function ChannelLink({ channel, active }: { channel: Channel; active: boolean }) {
  const unread = channel.unreadCount > 0;
  return (
    <Link
      to={`/chat/${channel.id}`}
      className={`flex items-center justify-between rounded px-2 py-1 text-sm hover:bg-white/10 ${
        active ? 'bg-white/20' : ''
      } ${unread ? 'font-bold' : 'text-white/80'}`}
    >
      <span># {channel.name}</span>
      {unread && (
        <span className="rounded-full bg-red-500 px-1.5 text-xs font-semibold">
          {channel.unreadCount}
        </span>
      )}
    </Link>
  );
}
