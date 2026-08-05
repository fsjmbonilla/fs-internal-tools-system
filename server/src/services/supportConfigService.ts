import { asc, eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { supportConfigs, taskColumns } from '../db/schema/index.js';

export type SupportConfigRow = typeof supportConfigs.$inferSelect;

export async function getSupportConfig(channelId: number): Promise<SupportConfigRow | null> {
  const [row] = await db.select().from(supportConfigs).where(eq(supportConfigs.channelId, channelId));
  return row ?? null;
}

export async function resolveIntakeColumnId(projectId: number): Promise<number | null> {
  const [row] = await db
    .select({ id: taskColumns.id })
    .from(taskColumns)
    .where(eq(taskColumns.projectId, projectId))
    .orderBy(asc(taskColumns.position))
    .limit(1);
  return row?.id ?? null;
}

export async function upsertSupportConfig(input: {
  channelId: number;
  projectId: number;
  intakeColumnId: number;
  aiEnabled?: boolean;
  instructions?: string | null;
}): Promise<SupportConfigRow> {
  const values = {
    channelId: input.channelId,
    projectId: input.projectId,
    intakeColumnId: input.intakeColumnId,
    aiEnabled: input.aiEnabled ?? true,
    instructions: input.instructions ?? null,
  };
  await db
    .insert(supportConfigs)
    .values(values)
    .onDuplicateKeyUpdate({
      set: {
        projectId: values.projectId,
        intakeColumnId: values.intakeColumnId,
        aiEnabled: values.aiEnabled,
        instructions: values.instructions,
      },
    });
  const row = await getSupportConfig(input.channelId);
  if (!row) throw new Error('support config upsert failed');
  return row;
}
