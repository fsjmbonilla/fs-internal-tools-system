import { useCallback, useEffect, useState } from 'react';
import { Markdown } from '@/features/docs/Markdown';
import { fileToRows } from '@/features/sheets/xlsx';
import { fetchAuthedBytes, fileUrl } from '@/lib/uploads';
import { PREVIEWABLE } from './previewable';

/**
 * In-app, view-only previews of uploaded office files.
 *
 * Everything renders client-side; the server does nothing but stream the bytes
 * it already streamed. That is the whole reason this needs no extra container —
 * OnlyOffice stays the documented option if *editing* uploaded files ever
 * becomes a real requirement.
 *
 * docx is converted to **markdown**, not HTML, and rendered through the app's
 * existing `<Markdown>` component. mammoth can emit HTML directly, but that
 * would mean a second HTML render path and a second sanitiser to keep correct;
 * routing through the one that already runs rehype-sanitize keeps the invariant
 * — one sanitised render path — literally true. A malicious docx with embedded
 * markup therefore lands as inert text.
 */

type Kind = 'sheet' | 'doc' | 'pdf' | 'image' | 'none';

function kindOf(mimeType: string): Kind {
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType === 'application/pdf') return 'pdf';
  if (mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
    return 'doc';
  }
  return PREVIEWABLE.has(mimeType) ? 'sheet' : 'none';
}

/** Uploaded-attachment preview — the original surface, now a thin wrapper. */
export function OfficePreview({
  attachmentId,
  fileName,
  mimeType,
}: {
  attachmentId: number;
  fileName: string;
  mimeType: string;
}) {
  const loadBytes = useCallback(() => fetchAuthedBytes(fileUrl(attachmentId)), [attachmentId]);
  return <FilePreview loadBytes={loadBytes} fileName={fileName} mimeType={mimeType} />;
}

/**
 * The renderer itself, source-agnostic: it only needs a way to get bytes.
 * Uploaded attachments and Drive exports both land here.
 */
export function FilePreview({
  loadBytes,
  fileName,
  mimeType,
}: {
  loadBytes: () => Promise<ArrayBuffer>;
  fileName: string;
  mimeType: string;
}) {
  const kind = kindOf(mimeType);
  const [sheets, setSheets] = useState<{ name: string; rows: string[][] }[] | null>(null);
  const [markdown, setMarkdown] = useState<string | null>(null);
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let created: string | null = null;

    (async () => {
      try {
        const bytes = await loadBytes();
        if (cancelled) return;

        if (kind === 'sheet') {
          setSheets(fileToRows(bytes));
        } else if (kind === 'doc') {
          // Loaded on demand: mammoth is ~200 kB and most previews are not docx.
          const mammoth = await import('mammoth');
          // `convertToMarkdown` exists at runtime (checked against the installed
          // 1.12 package — it is in the module's exports) but is missing from the
          // bundled type declarations, which only describe convertToHtml. The
          // cast is narrow and deliberate; the alternative is rendering HTML and
          // owning a second sanitiser.
          const convert = (
            mammoth as unknown as {
              convertToMarkdown: (input: { arrayBuffer: ArrayBuffer }) => Promise<{ value: string }>;
            }
          ).convertToMarkdown;
          const result = await convert({ arrayBuffer: bytes });
          if (!cancelled) setMarkdown(result.value);
        } else if (kind === 'pdf' || kind === 'image') {
          created = URL.createObjectURL(new Blob([bytes], { type: mimeType }));
          if (!cancelled) setObjectUrl(created);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Preview failed');
      }
    })();

    return () => {
      cancelled = true;
      if (created) URL.revokeObjectURL(created);
    };
  }, [loadBytes, kind, mimeType]);

  if (kind === 'none') {
    return <p className="p-4 text-sm text-muted-foreground">No preview for {fileName}.</p>;
  }
  if (error) {
    return (
      <p role="alert" className="p-4 text-sm text-destructive">
        {error}
      </p>
    );
  }

  if (kind === 'image') {
    return objectUrl ? (
      <img src={objectUrl} alt={fileName} className="max-h-[80vh] w-full object-contain" />
    ) : (
      <Loading />
    );
  }

  if (kind === 'pdf') {
    // sandbox with no allow-* tokens: the PDF viewer renders, scripts do not run.
    return objectUrl ? (
      <iframe title={fileName} src={objectUrl} sandbox="" className="h-[80vh] w-full rounded border" />
    ) : (
      <Loading />
    );
  }

  if (kind === 'doc') {
    return markdown === null ? (
      <Loading />
    ) : (
      <div className="max-h-[80vh] overflow-auto p-2">
        <Markdown content={markdown} />
      </div>
    );
  }

  if (!sheets) return <Loading />;
  return (
    <div className="max-h-[80vh] overflow-auto">
      {sheets.map((sheet) => (
        <div key={sheet.name} className="mb-4">
          <p className="mb-1 text-xs font-medium text-muted-foreground">{sheet.name}</p>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-xs">
              <tbody>
                {sheet.rows.map((row, r) => (
                  // Rows have no id of their own; index is the only key available
                  // and the table is static, so nothing reorders underneath it.
                  <tr key={r} className={r === 0 ? 'bg-muted font-medium' : undefined}>
                    {row.map((cell, c) => (
                      <td key={c} className="max-w-56 truncate border px-2 py-1">
                        {cell}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {sheet.rows.length >= 200 && (
            <p className="mt-1 text-xs text-muted-foreground">
              Showing the first 200 rows — download the file for the rest.
            </p>
          )}
        </div>
      ))}
    </div>
  );
}

function Loading() {
  return <p className="p-4 text-sm text-muted-foreground">Loading preview…</p>;
}
