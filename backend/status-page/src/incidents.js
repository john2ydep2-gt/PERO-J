import { readFile } from "node:fs/promises";

/**
 * @typedef {Object} IncidentUpdate
 * @property {string} at ISO timestamp
 * @property {"investigating"|"identified"|"monitoring"|"resolved"} status
 * @property {string} message
 *
 * @typedef {Object} Incident
 * @property {string} id
 * @property {string} title
 * @property {"minor"|"major"|"critical"|"maintenance"} impact
 * @property {string[]} components Component ids (stellar-rpc, indexer, oracle, api)
 * @property {string} startedAt
 * @property {string|null} resolvedAt
 * @property {IncidentUpdate[]} updates
 * @property {{ summary: string, rootCause: string, resolution: string, actionItems: string[] }|null} postMortem
 */

const VALID_IMPACT = new Set(["minor", "major", "critical", "maintenance"]);

/** Validate & normalise a raw incident; returns null for malformed entries. */
export function normaliseIncident(raw) {
  if (!raw || typeof raw !== "object" || !raw.id || !raw.title || !raw.startedAt) return null;
  if (Number.isNaN(Date.parse(raw.startedAt))) return null;
  return {
    id: String(raw.id),
    title: String(raw.title),
    impact: VALID_IMPACT.has(raw.impact) ? raw.impact : "minor",
    components: Array.isArray(raw.components) ? raw.components.map(String) : [],
    startedAt: raw.startedAt,
    resolvedAt: raw.resolvedAt ?? null,
    updates: Array.isArray(raw.updates)
      ? raw.updates.filter((u) => u && u.at && u.message).sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
      : [],
    postMortem: raw.postMortem ?? null,
  };
}

/** Load the incident post-mortem log, newest first. Missing/invalid files yield an empty log. */
export async function loadIncidents(file, logger = console) {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8"));
    const list = Array.isArray(parsed) ? parsed : parsed.incidents;
    return (Array.isArray(list) ? list : [])
      .map(normaliseIncident)
      .filter(Boolean)
      .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
  } catch (err) {
    if (err.code !== "ENOENT") logger.warn?.(`[status] failed to load incidents from ${file}: ${err.message}`);
    return [];
  }
}
