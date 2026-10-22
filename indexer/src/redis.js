import { EventEmitter } from "node:events";

const bus = new EventEmitter();
bus.setMaxListeners(100);
const memStorage = new Map();

export class InMemoryRedis extends EventEmitter {
  constructor() {
    super();
  }

  async get(key) {
    const item = memStorage.get(key);
    if (!item) return null;
    if (item.expiresAt && Date.now() > item.expiresAt) {
      memStorage.delete(key);
      return null;
    }
    return item.value;
  }

  async set(key, value, mode, duration) {
    let expiresAt = null;
    if (mode === "PX" && typeof duration === "number") {
      expiresAt = Date.now() + duration;
    } else if (mode === "EX" && typeof duration === "number") {
      expiresAt = Date.now() + duration * 1000;
    }
    memStorage.set(key, { value: String(value), expiresAt });
    return "OK";
  }

  async del(...keys) {
    let count = 0;
    const flatKeys = keys.flat();
    for (const key of flatKeys) {
      if (memStorage.delete(key)) count++;
    }
    return count;
  }

  async exists(key) {
    const val = await this.get(key);
    return val !== null ? 1 : 0;
  }

  async flushall() {
    const size = memStorage.size;
    memStorage.clear();
    return size;
  }

  async publish(channel, message) {
    const str = typeof message === "string" ? message : JSON.stringify(message);
    bus.emit(channel, str);
    return 1;
  }

  subscribe(channel, handler) {
    bus.on(channel, handler);
  }

  unsubscribe(channel, handler) {
    bus.off(channel, handler);
  }
}

let redisInstance = null;
let subInstance = null;

/**
 * Returns the shared Redis client or in-memory fallback.
 */
export function getRedisClient() {
  if (!redisInstance) {
    redisInstance = new InMemoryRedis();
  }
  return redisInstance;
}

/**
 * Returns the shared Redis subscriber client or in-memory fallback.
 */
export function getRedisSubscriber() {
  if (!subInstance) {
    subInstance = new InMemoryRedis();
  }
  return subInstance;
}

/**
 * Publish a message to a Redis/in-memory channel.
 */
export async function publish(channel, message, client = getRedisClient()) {
  if (!client) return false;
  try {
    const payload = typeof message === "string" ? message : JSON.stringify(message);
    await client.publish(channel, payload);
    return true;
  } catch (err) {
    console.warn(`[redis] publish to ${channel} failed: ${err.message}`);
    return false;
  }
}

/**
 * Subscribe to a Redis/in-memory channel.
 */
export function subscribe(channel, handler, sub = getRedisSubscriber()) {
  if (!sub) return;
  sub.subscribe(channel, handler);
}

/**
 * Reset memory storage and listeners (useful in tests).
 */
export function resetRedis() {
  memStorage.clear();
  bus.removeAllListeners();
}
