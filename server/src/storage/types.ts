export interface StorageDriver {
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  getStream(key: string): NodeJS.ReadableStream;
  getSignedGetUrl(key: string, ttlSeconds: number): Promise<string | null>;
  delete(key: string): Promise<void>;
  /**
   * Every key under a prefix. Used by the orphan sweep to find objects whose
   * database row is gone — the one thing a row-driven cleanup cannot see.
   */
  list(prefix: string): Promise<string[]>;
}
