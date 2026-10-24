import { fetchJson, requireString } from "./http.js";

const NOAA_ENDPOINT = "https://www.ncei.noaa.gov/cdo-web/api/v2/data";
const SPACEX_ENDPOINT = "https://api.spacexdata.com/v4/launches";
const COMPARATORS = {
  gt: (value, threshold) => value > threshold,
  gte: (value, threshold) => value >= threshold,
  lt: (value, threshold) => value < threshold,
  lte: (value, threshold) => value <= threshold,
  eq: (value, threshold) => value === threshold,
};
const LAUNCH_STATUSES = new Set(["success", "failure", "scrubbed", "cancelled"]);

function validateDate(value) {
  const date = requireString(value, "date");
  const parsedDate = new Date(`${date}T00:00:00Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
    Number.isNaN(parsedDate.valueOf()) ||
    parsedDate.toISOString().slice(0, 10) !== date
  ) {
    throw new TypeError("date must use YYYY-MM-DD format");
  }
  return date;
}

function resolveLaunchStatus(payload) {
  const explicitStatus = String(payload.status ?? "").toLowerCase();
  if (LAUNCH_STATUSES.has(explicitStatus)) {
    return explicitStatus;
  }
  if (payload.upcoming === true) {
    return null;
  }
  if (payload.success === true) {
    return "success";
  }
  if (payload.success === false) {
    return "failure";
  }
  return null;
}

export function createScienceWeatherAdapter({
  noaaEndpoint = NOAA_ENDPOINT,
  noaaToken,
  launchEndpoint = SPACEX_ENDPOINT,
  fetchImpl = globalThis.fetch,
}) {
  const weatherSource = requireString(noaaEndpoint, "noaaEndpoint");
  const launchSource = requireString(launchEndpoint, "launchEndpoint");
  new URL(weatherSource);
  new URL(launchSource);

  return {
    async resolveWeather({
      stationId,
      date: observationDate,
      metric,
      operator,
      threshold,
      unit,
    }) {
      const station = requireString(stationId, "stationId");
      const date = validateDate(observationDate);
      const datatype = requireString(metric, "metric").toUpperCase();
      const compare = COMPARATORS[operator];
      if (!compare) {
        throw new TypeError(`Unsupported weather comparison operator: ${operator}`);
      }
      if (!Number.isFinite(threshold)) {
        throw new TypeError("threshold must be a finite number");
      }
      if (datatype !== "TMAX" && datatype !== "TMIN" && datatype !== "PRCP") {
        throw new TypeError("metric must be TMAX, TMIN, or PRCP");
      }
      const expectedUnit = datatype === "PRCP" ? "mm" : "C";
      const normalizedUnit = requireString(unit, "unit").replace("°", "").toUpperCase();
      if (normalizedUnit !== expectedUnit.toUpperCase()) {
        throw new TypeError(`${datatype} thresholds must use ${expectedUnit}`);
      }

      const payload = await fetchJson(fetchImpl, weatherSource, {
        query: {
          datasetid: "GHCND",
          stationid: station,
          startdate: date,
          enddate: date,
          datatypeid: datatype,
          limit: 1000,
        },
        headers: noaaToken ? { token: noaaToken } : {},
      });
      if (payload?.results !== undefined && !Array.isArray(payload.results)) {
        throw new TypeError("NOAA response results must be an array");
      }

      const observation = (payload.results ?? []).find(
        (item) => item.datatype === datatype && item.date?.startsWith(date),
      );
      if (!observation) {
        return { status: "pending", reason: "observation_not_available" };
      }
      if (!Number.isFinite(observation.value)) {
        throw new TypeError("NOAA observation value must be a finite number");
      }

      const value = observation.value / 10;
      return {
        status: "resolved",
        outcome: compare(value, threshold),
        evidence: {
          source: weatherSource,
          stationId: station,
          date,
          metric: datatype,
          value,
          unit: expectedUnit,
        },
      };
    },

    async resolveLaunch({ launchId, outcome }) {
      const id = requireString(launchId, "launchId");
      const expectedOutcome = requireString(outcome, "outcome").toLowerCase();
      if (!LAUNCH_STATUSES.has(expectedOutcome)) {
        throw new TypeError(
          `outcome must be one of: ${Array.from(LAUNCH_STATUSES).join(", ")}`,
        );
      }

      const url = new URL(`${launchSource.replace(/\/+$/, "")}/${encodeURIComponent(id)}`);
      const payload = await fetchJson(fetchImpl, url.href);
      const observedStatus = resolveLaunchStatus(payload);
      if (!observedStatus) {
        return { status: "pending", reason: "launch_outcome_not_final" };
      }

      return {
        status: "resolved",
        outcome: observedStatus === expectedOutcome,
        evidence: {
          source: launchSource,
          launchId: id,
          observedStatus,
        },
      };
    },
  };
}
