import { getVisibleChannel, isChannelMember } from './channelService.js';
import { getVisibleProject, isProjectMember } from './projectService.js';

/**
 * What an agent may reach.
 *
 * Both agent surfaces — the MCP endpoint and AI routines — have to apply exactly
 * the same visibility and membership rules the REST routes apply. They used to
 * be written out in the MCP server; they live here now so the two surfaces cannot
 * drift apart, which is the failure the MCP module warns about in its own header:
 * a tool that reimplements a rule is a tool that will stop matching it.
 *
 * These are the *only* place an agent's authorization is decided. Anything new
 * that acts on behalf of a token or a routine calls these rather than repeating
 * the two-step (visible, then member).
 */

export interface AgentCaller {
  userId: number;
  isAdmin: boolean;
}

/** Reading a project needs only visibility. */
export async function projectForReading(projectId: number, caller: AgentCaller) {
  return getVisibleProject(projectId, caller.userId, caller.isAdmin);
}

/** Changing one needs membership as well — visibility first, so 404 wins over 403. */
export async function projectForWriting(projectId: number, caller: AgentCaller) {
  const project = await getVisibleProject(projectId, caller.userId, caller.isAdmin);
  if (!project) return null;
  if (!caller.isAdmin && !(await isProjectMember(projectId, caller.userId))) return null;
  return project;
}

export async function channelForReading(channelId: number, caller: AgentCaller) {
  return getVisibleChannel(channelId, caller.userId, caller.isAdmin);
}

/**
 * Posting into a channel needs membership, not just visibility — a public
 * channel is readable by everyone and writable by the people in it.
 */
export async function channelForWriting(channelId: number, caller: AgentCaller) {
  const channel = await getVisibleChannel(channelId, caller.userId, caller.isAdmin);
  if (!channel) return null;
  if (!caller.isAdmin && !(await isChannelMember(channelId, caller.userId))) return null;
  return channel;
}
