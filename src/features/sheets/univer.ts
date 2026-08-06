import '@univerjs/preset-sheets-core/lib/index.css';
import { createUniver, LocaleType, mergeLocales } from '@univerjs/presets';
import { UniverSheetsCorePreset } from '@univerjs/presets/preset-sheets-core';
import sheetsCoreEnUS from '@univerjs/presets/preset-sheets-core/locales/en-US';

/**
 * Univer, wrapped in the smallest surface this app needs.
 *
 * Univer is an imperative engine with no official React wrapper: it is handed a
 * DOM node and owns everything inside it. Keeping that behind a handle means the
 * page component never touches the engine directly, and — more importantly —
 * there is exactly one place responsible for disposing it. Two engines mounted
 * into one container fight over the same canvas and the symptoms look nothing
 * like the cause.
 *
 * The snapshot is the storage contract, as the master plan specifies:
 * `createWorkbook(snapshot)` in, `fWorkbook.save()` out. Verified against the
 * installed package (0.25.x) rather than the docs — `createUniver()` returns
 * `{ univer, univerAPI }`, and the Facade API is what carries both calls.
 *
 * Known and deliberate: xlsx import/export, charts, pivot tables and real
 * co-editing are paid Univer plugins. The design routes around the two that
 * matter — SheetJS for xlsx, and a lock instead of co-editing.
 */

export interface UniverHandle {
  /** The current workbook as a JSON string, ready to PATCH. */
  snapshot: () => string;
  /** Replace the workbook — used when a viewer sees someone else's save. */
  load: (data: string) => void;
  dispose: () => void;
}

/** A workbook for a sheet that has never been saved. Univer fills in the rest. */
const EMPTY_WORKBOOK = { id: 'workbook', name: 'Sheet', sheetOrder: [], sheets: {} };

function parseSnapshot(data: string): Record<string, unknown> {
  if (!data) return { ...EMPTY_WORKBOOK };
  try {
    const parsed: unknown = JSON.parse(data);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fall through
  }
  // A snapshot that will not parse is a corrupt row, not a reason to crash the
  // page: open an empty workbook so the sheet is at least recoverable.
  return { ...EMPTY_WORKBOOK };
}

export async function mountUniver(
  container: HTMLElement,
  data: string,
  onChange: () => void,
): Promise<UniverHandle> {
  const { univer, univerAPI } = createUniver({
    locale: LocaleType.EN_US,
    locales: { [LocaleType.EN_US]: mergeLocales(sheetsCoreEnUS) },
    presets: [UniverSheetsCorePreset({ container })],
  });

  univerAPI.createWorkbook(parseSnapshot(data));

  // Any command that mutates the document marks the page dirty. Listening to
  // commands rather than to a change event is what Univer actually exposes, and
  // it covers edits made through the UI and through the Facade API alike.
  const subscription = univerAPI.onCommandExecuted(() => onChange());

  return {
    snapshot: () => {
      const workbook = univerAPI.getActiveWorkbook();
      return workbook ? JSON.stringify(workbook.save()) : '';
    },
    load: (next: string) => {
      const workbook = univerAPI.getActiveWorkbook();
      // Dispose the old unit first: creating a second workbook without this
      // leaves both registered, and the "active" one becomes a coin toss.
      if (workbook) univerAPI.disposeUnit(workbook.getId());
      univerAPI.createWorkbook(parseSnapshot(next));
    },
    dispose: () => {
      subscription?.dispose?.();
      univer.dispose();
    },
  };
}
