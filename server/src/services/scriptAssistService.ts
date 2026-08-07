import { logger } from '../logger.js';
import type { TriageUsage } from './ai/triage.js';
import { aiProviderName, completeText, isAiConfigured } from './aiService.js';

/**
 * The AI assistant behind the script editor: an admin types an instruction,
 * the model reads the script, and the reply comes back as text — plus, in edit
 * mode, a full revised script the client may apply to the editor.
 *
 * It rides the same provider-switchable abstraction as support-intake triage —
 * `completeText()` from aiService, where AI_PROVIDER / AI_MODEL select the
 * backend — so whichever provider the deployment has configured answers here
 * too. The budget gate and the ai_usage ledger row live in the route, mirroring
 * supportIntake; `onUsage` fires exactly once per dispatched call — even one
 * that failed — because a dispatched call is billable either way.
 *
 * The script source is never logged from here: it is user-authored code, and
 * it stays out of server logs the same way the runner keeps it out.
 */

export type AssistMode = 'analyze' | 'generate' | 'edit';

export interface ScriptAssistInput {
  source: string;
  instruction: string;
  mode: AssistMode;
  /** Called exactly once if a paid call was dispatched — even one that failed. */
  onUsage?: (usage: TriageUsage) => void;
}

export interface ScriptAssistResult {
  reply: string;
  /** Only for mode 'edit': the first ```python fence in the reply, else null. */
  revisedSource: string | null;
}

/** Only when NO provider is configured — whichever backend AI_PROVIDER selects. */
export const AI_NOT_CONFIGURED =
  "No AI provider is configured — set the active provider's API key in server/.env.";

// Generous, because an edit reply carries the whole revised script.
const MAX_TOKENS = 16_384;

function systemPrompt(mode: AssistMode): string {
  return [
    'You are helping an admin write a Python script that runs server-side in a sandbox',
    'with a hard timeout and memory cap. The script may `import fs_sdk`, a helper that',
    "carries the run's scoped token; every call outside the script's scopes returns 403.",
    'fs_sdk provides: list_projects(), get_board(project_id),',
    'create_ticket(project_id, column_id, title, description=None, priority=None),',
    'post_message(channel_id, text), read_sheet(sheet_id), write_sheet(sheet_id, data),',
    'and request(method, path, body=None) for any other platform API call.',
    'Only the Python standard library is available — no third-party packages, and no',
    'network egress except the platform API.',
    mode === 'edit'
      ? 'Return ONLY the full revised script in a single ```python fence — no prose before or after it.'
      : 'Follow the instruction. Put any code you show in ```python fences.',
  ].join(' ');
}

function userMessage(input: ScriptAssistInput): string {
  return [
    `Instruction (mode: ${input.mode}): ${input.instruction}`,
    '',
    'Current script:',
    '```python',
    input.source,
    '```',
  ].join('\n');
}

/** The first ```python fence, or null when the reply has none (or it never closed). */
function extractPythonFence(reply: string): string | null {
  const match = reply.match(/```python[^\n]*\n([\s\S]*?)```/);
  return match ? match[1].replace(/\n$/, '') : null;
}

export function isScriptAssistConfigured(): boolean {
  return isAiConfigured();
}

export async function assistScript(input: ScriptAssistInput): Promise<ScriptAssistResult> {
  if (!isAiConfigured()) throw new Error(AI_NOT_CONFIGURED);

  try {
    const reply = await completeText({
      system: systemPrompt(input.mode),
      prompt: userMessage(input),
      maxTokens: MAX_TOKENS,
      onUsage: input.onUsage,
    });

    // A reply that was cut off mid-fence extracts to null, so a truncated edit
    // can never be applied to the editor as if it were whole. Generate replies
    // extract too — applying one must never paste the ```python fence itself
    // into the editor (that shipped once).
    const revisedSource = input.mode === 'analyze' ? null : extractPythonFence(reply);
    return { reply, revisedSource };
  } catch (err) {
    // Deliberately no input.source here — user-authored code stays out of logs.
    logger.error({ err, mode: input.mode, provider: aiProviderName() }, 'script assist failed');
    throw err instanceof Error ? err : new Error('The AI request failed');
  }
}
