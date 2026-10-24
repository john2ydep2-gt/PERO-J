const DEFAULT_MAX_AGE_MS = 10 * 60 * 1000;

function getTimestamp(response) {
  const value = response?.last_updated ?? response?.timestamp;

  if (value instanceof Date) {
    return value.getTime();
  }

  if (typeof value === "number" || (typeof value === "string" && /^\d+(\.\d+)?$/.test(value))) {
    const numericValue = Number(value);
    return numericValue < 1e12 ? numericValue * 1000 : numericValue;
  }

  return Date.parse(value);
}

function isFresh(response, now, maxAgeMs) {
  const timestamp = getTimestamp(response);
  const age = now - timestamp;

  return Number.isFinite(timestamp) && age >= 0 && age < maxAgeMs;
}

export async function fetchFreshFromAdapters(
  adapters,
  { maxAgeMs = DEFAULT_MAX_AGE_MS, now = Date.now } = {},
) {
  if (!Array.isArray(adapters) || adapters.length === 0) {
    throw new TypeError("At least one oracle adapter is required");
  }
  if (!Number.isFinite(maxAgeMs) || maxAgeMs <= 0) {
    throw new RangeError("maxAgeMs must be a positive finite number");
  }
  if (typeof now !== "function") {
    throw new TypeError("now must be a function");
  }

  const failures = [];

  for (const adapter of adapters) {
    if (!adapter || typeof adapter.fetch !== "function") {
      throw new TypeError("Each oracle adapter must provide a fetch function");
    }

    try {
      const response = await adapter.fetch();
      if (isFresh(response, now(), maxAgeMs)) {
        return response;
      }

      failures.push(
        new Error(`Oracle adapter "${adapter.name ?? "unnamed"}" returned stale or invalid data`),
      );
    } catch (error) {
      failures.push(
        new Error(`Oracle adapter "${adapter.name ?? "unnamed"}" failed`, { cause: error }),
      );
    }
  }

  throw new AggregateError(failures, "No oracle adapter returned fresh data");
}
