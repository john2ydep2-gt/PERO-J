export async function fetchJson(fetchImpl, endpoint, { query = {}, headers = {} } = {}) {
  if (typeof fetchImpl !== "function") {
    throw new TypeError("A fetch implementation is required");
  }

  const url = new URL(endpoint);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null) {
      url.searchParams.set(key, String(value));
    }
  }

  const response = await fetchImpl(url, { headers });
  if (!response.ok) {
    throw new Error(`Oracle source returned HTTP ${response.status}`);
  }

  return response.json();
}

export function requireString(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  return value.trim();
}
