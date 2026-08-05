import type { Socket } from 'socket.io';
import { config } from '../config.js';

/**
 * Per-socket token bucket for message sends.
 *
 * The HTTP send path sits behind express-rate-limit; the socket path had no
 * limit at all, and it is the cheaper one to abuse — every accepted message
 * fans out to every member of the channel in real time.
 *
 * Refilling continuously (rather than a fixed window) lets a normal burst of
 * replies through while still capping sustained volume.
 */
const CAPACITY = 10;
const REFILL_PER_SEC = 1;

interface Bucket {
  tokens: number;
  updatedAt: number;
}

export function takeSendToken(socket: Socket): boolean {
  // Suites send in tight loops; limiting there would make them flaky, not safe.
  if (config.NODE_ENV === 'test') return true;

  const now = Date.now();
  const bucket: Bucket = socket.data.sendBucket ?? { tokens: CAPACITY, updatedAt: now };
  const elapsedSec = (now - bucket.updatedAt) / 1000;
  bucket.tokens = Math.min(CAPACITY, bucket.tokens + elapsedSec * REFILL_PER_SEC);
  bucket.updatedAt = now;

  if (bucket.tokens < 1) {
    socket.data.sendBucket = bucket;
    return false;
  }
  bucket.tokens -= 1;
  socket.data.sendBucket = bucket;
  return true;
}
