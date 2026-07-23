import { config } from '../config.js';
import { LocalStorageDriver } from './local.js';
import { S3StorageDriver } from './s3.js';
import type { StorageDriver } from './types.js';

let driver: StorageDriver | null = null;

export function getStorageDriver(): StorageDriver {
  if (driver) return driver;
  driver =
    config.STORAGE_DRIVER === 's3'
      ? new S3StorageDriver(config.S3_BUCKET ?? '', config.AWS_REGION)
      : new LocalStorageDriver(config.UPLOAD_DIR);
  return driver;
}
