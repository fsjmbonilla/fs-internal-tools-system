import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router';
import { ScrollArea } from '@/components/ui/scroll-area';
import { logoutUser } from '@/features/auth/api';
import { useAuthStore } from '@/features/auth/authStore';
import { api } from '@/lib/api';
import { listChannels, listMyDms, type DmSummary } from './api';
import { NewChannelDialog } from './NewChannelDialog';
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
  const { data: dmData } = useQuery({
    queryKey: ['dms'],
    queryFn: listMyDms,
    refetchInterval: 15_000,
  });
  const { data: deptData } = useQuery({
    queryKey: ['departments'],
    queryFn: () => api<{ departments: Department[] }>('/api/departments'),
  });

  const channels = channelData?.channels ?? [];
  const dms = dmData?.dms ?? [];
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
        <SidebarSection title="Channels" action={<NewChannelDialog departments={departments} />}>
          {orgWide.map((c) => (
            <ChannelLink key={c.id} channel={c} active={String(c.id) === channelId} />
          ))}
          {channels.filter((c) => c.type !== 'dm').length === 0 && (
            <p className="px-2 py-1 text-xs text-white/40">
              No channels yet — use + to create one.
            </p>
          )}
        </SidebarSection>
        {grouped.map(({ dept, channels: deptChannels }) => (
          <SidebarSection key={dept.id} title={dept.name}>
            {deptChannels.map((c) => (
              <ChannelLink key={c.id} channel={c} active={String(c.id) === channelId} />
            ))}
          </SidebarSection>
        ))}
        <SidebarSection title="Direct messages">
          {dms.map((dm) => (
            <DmLink key={dm.id} dm={dm} active={String(dm.id) === channelId} />
          ))}
          {dms.length === 0 && (
            <p className="px-2 py-1 text-xs text-white/40">
              None yet — press ⌘K / Ctrl-K and pick someone.
            </p>
          )}
        </SidebarSection>
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

function SidebarSection({
  title,
  action,
  children,
}: {
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="mb-4">
      <div className="flex items-center justify-between px-2 py-1 text-xs font-semibold uppercase tracking-wide text-white/50">
        <span>{title}</span>
        {action}
      </div>
      {children}
    </div>
  );
}

function DmLink({ dm, active }: { dm: DmSummary; active: boolean }) {
  const unread = dm.unreadCount > 0;
  // A DM whose counterpart was deleted still has history worth reaching.
  const label = dm.user?.displayName ?? 'Unknown person';
  return (
    <Link
      to={`/chat/${dm.id}`}
      className={`flex items-center justify-between rounded px-2 py-1 text-sm hover:bg-white/10 ${
        active ? 'bg-white/20' : ''
      } ${unread ? 'font-bold' : 'text-white/80'}`}
    >
      <span className="truncate">{label}</span>
      {unread && (
        <span className="ml-1 rounded-full bg-red-500 px-1.5 text-xs font-semibold">
          {dm.unreadCount}
        </span>
      )}
    </Link>
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
