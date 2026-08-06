import * as XLSX from 'xlsx';

/**
 * xlsx ⇄ Univer workbook snapshot.
 *
 * SheetJS rather than Univer's own importer because that one is a paid plugin —
 * the master plan routes around it deliberately. This module owns the whole
 * translation, so the shape mismatch between the two libraries lives in one file.
 *
 * **The version matters.** The npm `xlsx` package is frozen at 0.18.5 with two
 * unpatched CVEs (prototype pollution, ReDoS). This project installs the official
 * 0.20.3 tarball vendored at `vendor/xlsx-0.20.3.tgz`, with a package.json
 * `overrides` entry so no transitive dependency can pull the registry version.
 * Do not "fix" this by running `npm install xlsx`.
 *
 * What does not survive a round trip, and why that is expected: VBA macros from
 * .xlsm are stripped (true of every web spreadsheet, Google's included), and
 * charts/pivot tables are not represented in either direction. Values and
 * formulas do survive, which is what the acceptance criteria ask for.
 */

/** Univer's cell: `v` is the value, `f` the formula (with its leading `=`). */
interface UniverCell {
  v?: string | number | boolean;
  f?: string;
}
type CellData = Record<string, Record<string, UniverCell>>;

interface UniverSheet {
  id?: string;
  name?: string;
  cellData?: CellData;
  rowCount?: number;
  columnCount?: number;
}

export interface UniverSnapshot {
  id?: string;
  name?: string;
  sheetOrder?: string[];
  sheets?: Record<string, UniverSheet>;
  [key: string]: unknown;
}

/** A worksheet's used range as rows of cells, preserving formulas. */
function sheetToCellData(ws: XLSX.WorkSheet): { cellData: CellData; rows: number; cols: number } {
  const cellData: CellData = {};
  const ref = ws['!ref'];
  if (!ref) return { cellData, rows: 0, cols: 0 };
  const range = XLSX.utils.decode_range(ref);

  for (let r = range.s.r; r <= range.e.r; r++) {
    for (let c = range.s.c; c <= range.e.c; c++) {
      const cell = ws[XLSX.utils.encode_cell({ r, c })] as XLSX.CellObject | undefined;
      if (!cell) continue;
      const out: UniverCell = {};
      // Formula first: a cell with `f` also carries SheetJS's cached value, and
      // keeping both lets Univer show something before it recalculates.
      if (cell.f) out.f = cell.f.startsWith('=') ? cell.f : `=${cell.f}`;
      if (cell.v !== undefined && cell.v !== null) {
        out.v = cell.v instanceof Date ? cell.v.toISOString() : (cell.v as string | number | boolean);
      }
      if (out.v === undefined && out.f === undefined) continue;
      (cellData[String(r)] ??= {})[String(c)] = out;
    }
  }
  return { cellData, rows: range.e.r + 1, cols: range.e.c + 1 };
}

/** Every sheet of an uploaded workbook, as a Univer snapshot. */
export function xlsxToSnapshot(buffer: ArrayBuffer, name = 'Imported'): UniverSnapshot {
  const wb = XLSX.read(buffer, { type: 'array', cellFormula: true, cellDates: true });
  const sheets: Record<string, UniverSheet> = {};
  const sheetOrder: string[] = [];

  wb.SheetNames.forEach((sheetName, index) => {
    const id = `sheet-${index + 1}`;
    const { cellData, rows, cols } = sheetToCellData(wb.Sheets[sheetName]);
    sheets[id] = {
      id,
      name: sheetName,
      cellData,
      // A little headroom, so an imported sheet is not pinned to its used range.
      rowCount: Math.max(rows + 20, 100),
      columnCount: Math.max(cols + 5, 20),
    };
    sheetOrder.push(id);
  });

  return { id: 'workbook', name, sheetOrder, sheets };
}

/** True when the file carries VBA, which no web spreadsheet can run. */
export function hasMacros(fileName: string): boolean {
  return /\.xlsm$/i.test(fileName);
}

/** A Univer snapshot as an xlsx workbook, ready to download. */
export function snapshotToXlsx(snapshot: UniverSnapshot): Blob {
  const wb = XLSX.utils.book_new();
  const order = snapshot.sheetOrder?.length
    ? snapshot.sheetOrder
    : Object.keys(snapshot.sheets ?? {});

  for (const sheetId of order) {
    const sheet = snapshot.sheets?.[sheetId];
    if (!sheet) continue;
    const ws: XLSX.WorkSheet = {};
    let maxRow = 0;
    let maxCol = 0;

    for (const [rowKey, cols] of Object.entries(sheet.cellData ?? {})) {
      for (const [colKey, cell] of Object.entries(cols)) {
        const r = Number(rowKey);
        const c = Number(colKey);
        if (!Number.isInteger(r) || !Number.isInteger(c)) continue;
        const address = XLSX.utils.encode_cell({ r, c });
        const value = cell.v;
        const out: XLSX.CellObject =
          typeof value === 'number'
            ? { t: 'n', v: value }
            : typeof value === 'boolean'
              ? { t: 'b', v: value }
              : { t: 's', v: value === undefined ? '' : String(value) };
        // Excel stores formulas without the leading '='.
        if (cell.f) out.f = cell.f.replace(/^=/, '');
        ws[address] = out;
        maxRow = Math.max(maxRow, r);
        maxCol = Math.max(maxCol, c);
      }
    }

    ws['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: maxRow, c: maxCol } });
    // Excel refuses sheet names over 31 chars or containing []:*?/\
    const safeName = (sheet.name ?? sheetId).slice(0, 31).replace(/[[\]:*?/\\]/g, '-');
    XLSX.utils.book_append_sheet(wb, ws, safeName);
  }

  const out = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
  return new Blob([out], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
}

/**
 * Rows of a spreadsheet-like attachment, for the read-only preview grid.
 *
 * Shows *stored* values. SheetJS has no formula engine, so a cell whose formula
 * was saved without a cached result previews as blank — Excel and LibreOffice
 * both cache results, so real files are unaffected, but a file generated
 * programmatically may show gaps. The preview is deliberately not worth booting
 * Univer for; anyone who needs computed values can open or download the file.
 */
export function fileToRows(buffer: ArrayBuffer, limit = 200): { name: string; rows: string[][] }[] {
  const wb = XLSX.read(buffer, { type: 'array', cellDates: true });
  return wb.SheetNames.map((name) => {
    const rows = XLSX.utils.sheet_to_json<string[]>(wb.Sheets[name], {
      header: 1,
      raw: false,
      defval: '',
    }) as string[][];
    return { name, rows: rows.slice(0, limit) };
  });
}
