import { getVisibleChannel, isChannelMember } from './channelService.js';
import { getVisibleProject, isProjectMember } from './projectService.js';

/**
 * Who may reach what.
 *
 * Every non-REST surface answers to the same visibility and membership rules the
 * REST routes apply, and this is where those rules are decided: the MCP endpoint,
 * AI routines, and the socket handlers all call these rather than repeating the
 * two-step (visible, then member). Each of them had written it out separately at
 * some point, and each time the copies started to disagree — an agent surface
 * that reimplements a rule is an agent surface that will stop matching it.
 *
 * Deliberately agnostic about *who* is calling. A socket acts for a person and a
 * routine acts for a bot, but the question — can this user id see it, and are
 * they a member — is identical, so the answer belongs in one function rather than
 * one per caller shape.
 *
 * The routes themselves keep their own guards, which throw AppError to produce
 * the right status code. These return null instead, because a socket has no
 * status code to return and an agent needs a value it can reason about.
 */

export interface Caller {
  userId: number;
  isAdmin: boolean;
  /**
   * The human whose Google connection the caller's Google tools may use —
   * a routine's owner, a service token's creator. Agents act as bot users,
   * and a bot cannot hold a Google grant of its own; what it borrows is the
   * connection of the person who empowered it, which is also who consented
   * to the scopes it was given. Absent means Google tools refuse.
   */
  googleUserId?: number;
}

/** Reading a project needs only visibility. */
export async function projectForReading(projectId: number, caller: Caller) {
  return getVisibleProject(projectId, caller.userId, caller.isAdmin);
}

/** Changing one needs membership as well — visibility first, so 404 wins over 403. */
export async function projectForWriting(projectId: number, caller: Caller) {
  const project = await getVisibleProject(projectId, caller.userId, caller.isAdmin);
  if (!project) return null;
  if (!caller.isAdmin && !(await isProjectMember(projectId, caller.userId))) return null;
  return project;
}

export async function channelForReading(channelId: number, caller: Caller) {
  return getVisibleChannel(channelId, caller.userId, caller.isAdmin);
}

/**
 * Posting into a channel needs membership, not just visibility — a public
 * channel is readable by everyone and writable by the people in it.
 */
export async function channelForWriting(channelId: number, caller: Caller) {
  const channel = await getVisibleChannel(channelId, caller.userId, caller.isAdmin);
  if (!channel) return null;
  if (!caller.isAdmin && !(await isChannelMember(channelId, caller.userId))) return null;
  return channel;
}
