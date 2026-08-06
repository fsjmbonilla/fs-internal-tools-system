import { getGooglePort, type CalendarEvent, type CalendarEventInput } from './google/port.js';
import { requireConnection, withGoogle } from './googleService.js';

/**
 * Calendar, always through the caller's own connection. Thin on purpose: the
 * connection/broken/dead-grant story lives in `googleService`, Google lives
 * behind the port, and this file is just the pairing of the two — which is
 * also exactly what the agent tools call, so REST and agents cannot drift.
 */

export async function listEvents(
  userId: number,
  fromIso: string,
  toIso: string,
): Promise<CalendarEvent[]> {
  const account = await requireConnection('user', userId);
  return withGoogle(account, (token) => getGooglePort().listEvents(token, fromIso, toIso));
}

export async function createEvent(
  userId: number,
  input: CalendarEventInput,
): Promise<CalendarEvent> {
  const account = await requireConnection('user', userId);
  return withGoogle(account, (token) => getGooglePort().createEvent(token, input));
}
