import { fetchJson, requireString } from "./http.js";

const FINAL_STATUSES = new Set(["certified", "final", "official"]);

function getElection(payload) {
  const election = payload?.election ?? payload;
  if (!election || typeof election !== "object") {
    throw new TypeError("Election feed must contain an election object");
  }
  if (!Array.isArray(election.races)) {
    throw new TypeError("Election feed must contain a races array");
  }
  return election;
}

function getWinnerId(race) {
  const explicitWinner = race.winnerId ?? race.winnerCandidateId;
  if (explicitWinner !== undefined && explicitWinner !== null) {
    return String(explicitWinner);
  }

  if (!Array.isArray(race.candidates)) {
    return null;
  }
  const winners = race.candidates.filter((candidate) => candidate.winner === true);
  if (winners.length > 1) {
    throw new TypeError("Election feed identifies more than one winner for a race");
  }
  const winnerId = winners[0]?.candidateId ?? winners[0]?.id;
  return winnerId === undefined || winnerId === null ? null : String(winnerId);
}

export function createPoliticsAdapter({
  endpoint,
  apiKey,
  fetchImpl = globalThis.fetch,
}) {
  const sourceEndpoint = requireString(endpoint, "endpoint");
  new URL(sourceEndpoint);

  return {
    async resolve({ electionId, raceId, candidateId }) {
      const election = requireString(electionId, "electionId");
      const race = requireString(raceId, "raceId");
      const candidate = requireString(candidateId, "candidateId");
      const payload = await fetchJson(fetchImpl, sourceEndpoint, {
        query: { electionId: election },
        headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      });
      const result = getElection(payload);
      const electionStatus = String(result.status ?? "").toLowerCase();
      const matchingRace = result.races.find(
        (item) => String(item.id ?? item.raceId ?? "") === race,
      );

      if (!matchingRace) {
        return { status: "pending", reason: "race_not_found" };
      }
      if (!Array.isArray(matchingRace.candidates)) {
        throw new TypeError("Election race must contain a candidates array");
      }
      const candidateExists = matchingRace.candidates.some(
        (item) => String(item.candidateId ?? item.id ?? "") === candidate,
      );
      if (!candidateExists) {
        throw new TypeError(`Candidate ${candidate} is not listed in race ${race}`);
      }

      const raceStatus = String(matchingRace.status ?? electionStatus).toLowerCase();
      if (!FINAL_STATUSES.has(raceStatus)) {
        return { status: "pending", reason: "results_not_final" };
      }

      const winnerId = getWinnerId(matchingRace);
      if (winnerId === null) {
        return { status: "pending", reason: "winner_not_reported" };
      }

      return {
        status: "resolved",
        outcome: winnerId === candidate,
        evidence: {
          source: sourceEndpoint,
          electionId: election,
          raceId: race,
          winnerId,
          resultStatus: raceStatus,
        },
      };
    },
  };
}
