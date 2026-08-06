/**
 * Image references inside a rich note.
 *
 * A note's images are attachments behind `GET /api/files/:id`, which requires an
 * `Authorization` header — a browser `<img src>` sends no such header, so a plain
 * URL in the document would render as a broken image. The app's existing answer
 * (see `features/files/Lightbox`) is to fetch the bytes and hand the tag an
 * object URL.
 *
 * So the stored document holds a *reference*, `fs-attachment:<id>`, and the two
 * functions below swap it for a live object URL on the way into the editor and
 * back again on the way out. Storing the object URL itself would be worse than
 * broken: those URLs die with the page, so the note would look fine until reload.
 *
 * Kept pure and separate from the editor so the round trip can be tested without
 * mounting one.
 */

export const ATTACHMENT_SCHEME = 'fs-attachment:';

export interface DocNode {
  type?: string;
  attrs?: Record<string, unknown>;
  content?: DocNode[];
  [key: string]: unknown;
}

export function attachmentRef(id: number): string {
  return `${ATTACHMENT_SCHEME}${id}`;
}

/** The attachment id a stored src points at, or null if it is not a reference. */
export function refToId(src: unknown): number | null {
  if (typeof src !== 'string' || !src.startsWith(ATTACHMENT_SCHEME)) return null;
  const id = Number(src.slice(ATTACHMENT_SCHEME.length));
  return Number.isInteger(id) && id > 0 ? id : null;
}

/** Every attachment id referenced by an image in the document. */
export function referencedAttachmentIds(doc: DocNode | null): number[] {
  const found = new Set<number>();
  walk(doc, (node) => {
    const id = refToId(node.attrs?.src);
    if (id !== null) found.add(id);
  });
  return [...found];
}

/**
 * Rewrite every image src through `map`, leaving the rest of the document alone.
 * Returns a new document; the input is not mutated, because the editor holds on
 * to the object it was given.
 */
export function mapImageSrc(doc: DocNode | null, map: (src: unknown) => unknown): DocNode | null {
  if (!doc) return doc;
  const next: DocNode = { ...doc };
  if (next.attrs && 'src' in next.attrs) {
    next.attrs = { ...next.attrs, src: map(next.attrs.src) };
  }
  if (Array.isArray(next.content)) {
    next.content = next.content.map((child) => mapImageSrc(child, map) as DocNode);
  }
  return next;
}

/** Stored → editor: `fs-attachment:7` becomes the object URL fetched for 7. */
export function toDisplayDoc(doc: DocNode | null, urls: Map<number, string>): DocNode | null {
  return mapImageSrc(doc, (src) => {
    const id = refToId(src);
    if (id === null) return src;
    // An image whose bytes failed to load keeps its reference rather than
    // becoming an empty src, so saving cannot silently drop it.
    return urls.get(id) ?? src;
  });
}

/** Editor → stored: an object URL becomes the reference it came from. */
export function toStoredDoc(doc: DocNode | null, urls: Map<number, string>): DocNode | null {
  const byUrl = new Map([...urls].map(([id, url]) => [url, id]));
  return mapImageSrc(doc, (src) => {
    if (typeof src !== 'string') return src;
    const id = byUrl.get(src);
    return id === undefined ? src : attachmentRef(id);
  });
}

function walk(node: DocNode | null, visit: (node: DocNode) => void): void {
  if (!node) return;
  visit(node);
  if (Array.isArray(node.content)) for (const child of node.content) walk(child, visit);
}
