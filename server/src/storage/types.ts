export interface StorageDriver {
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  getStream(key: string): NodeJS.ReadableStream;
  getSignedGetUrl(key: string, ttlSeconds: number): Promise<string | null>;
  delete(key: string): Promise<void>;
}
