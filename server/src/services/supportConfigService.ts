import { and, asc, eq } from 'drizzle-orm';
import { db, type Executor } from '../db/index.js';
import { supportConfigs, taskColumns } from '../db/schema/index.js';

export type SupportConfigRow = typeof supportConfigs.$inferSelect;

export async function getSupportConfig(
  channelId: number,
  exec: Executor = db,
): Promise<SupportConfigRow | null> {
  const [row] = await exec.select().from(supportConfigs).where(eq(supportConfigs.channelId, channelId));
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

/**
 * A column id supplied by the caller has to belong to the project it will file into.
 * Accepting one from another project produces a ticket whose projectId and columnId
 * disagree; getBoard filters by projectId, so it renders on no board at all and the
 * ticket silently vanishes.
 */
export async function columnBelongsToProject(columnId: number, projectId: number): Promise<boolean> {
  const [row] = await db
    .select({ id: taskColumns.id })
    .from(taskColumns)
    .where(and(eq(taskColumns.id, columnId), eq(taskColumns.projectId, projectId)))
    .limit(1);
  return row !== undefined;
}

export async function upsertSupportConfig(input: {
  channelId: number;
  projectId: number;
  intakeColumnId: number;
  aiEnabled?: boolean;
  instructions?: string | null;
}, exec: Executor = db): Promise<SupportConfigRow> {
  const values = {
    channelId: input.channelId,
    projectId: input.projectId,
    intakeColumnId: input.intakeColumnId,
    aiEnabled: input.aiEnabled ?? true,
    instructions: input.instructions ?? null,
  };
  await exec
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
  const row = await getSupportConfig(input.channelId, exec);
  if (!row) throw new Error('support config upsert failed');
  return row;
}
