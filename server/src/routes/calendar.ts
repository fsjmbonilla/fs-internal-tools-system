import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, requireUserAuth } from '../middleware/auth.js';
import { AppError } from '../middleware/errorHandler.js';
import { validate } from '../middleware/validate.js';
import { createEvent, listEvents } from '../services/calendarService.js';

/**
 * The caller's own Google Calendar. `requireUserAuth` for the same reason as
 * notes: this is personal data. Agents reach calendars only through the tool
 * registry, where the new calendar scopes gate them explicitly.
 */
export const calendarRouter = Router();
calendarRouter.use(requireAuth, requireUserAuth);

const isoDate = z.string().refine((s) => !Number.isNaN(Date.parse(s)), 'not a date');

calendarRouter.get('/events', async (req, res) => {
  const query = z.object({ from: isoDate, to: isoDate }).safeParse(req.query);
  if (!query.success) throw new AppError(400, 'validation_error', 'from and to must be dates');
  const events = await listEvents(
    req.auth!.userId,
    new Date(query.data.from).toISOString(),
    new Date(query.data.to).toISOString(),
  );
  res.json({ events });
});

const createBody = z
  .object({
    title: z.string().min(1).max(300),
    start: isoDate,
    end: isoDate,
    attendees: z.array(z.string().email()).max(50).optional(),
    description: z.string().max(10_000).optional(),
    location: z.string().max(1000).optional(),
  })
  .refine((b) => Date.parse(b.end) > Date.parse(b.start), {
    message: 'end must be after start',
  });

calendarRouter.post('/events', validate(createBody), async (req, res) => {
  const input = req.valid as z.infer<typeof createBody>;
  const event = await createEvent(req.auth!.userId, {
    ...input,
    start: new Date(input.start).toISOString(),
    end: new Date(input.end).toISOString(),
  });
  res.status(201).json({ event });
});
