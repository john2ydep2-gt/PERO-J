import Redis from 'ioredis';

let client;

/** Lazily create the shared Redis client; returns null when REDIS_URL is unset. */
export function getRedis() {
  if (client === undefined) {
    client = process.env.REDIS_URL
      ? new Redis(process.env.REDIS_URL, {
          maxRetriesPerRequest: 1,
          enableOfflineQueue: false,
        })
      : null;
    client?.on('error', (err) => console.warn(`[redis] ${err.message}`));
  }
  return client;
}

/**
 * Publish a JSON message to a channel. Never throws: Redis failures must not
 * block the caller (e.g. the indexing transaction).
 */
export async function publish(channel, message, redis = getRedis()) {
  if (!redis) return false;
  try {
    await redis.publish(channel, JSON.stringify(message));
    return true;
  } catch (err) {
    console.warn(`[redis] publish to ${channel} failed: ${err.message}`);
    return false;
  }
}
