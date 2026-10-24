import http from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import { StatusMonitor } from "./monitor.js";
import { loadIncidents } from "./incidents.js";

const PAGE_PATH = fileURLToPath(new URL("../public/index.html", import.meta.url));

function sendJson(res, status, body) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
  });
  res.end(JSON.stringify(body));
}

/**
 * Create the status page HTTP server.
 *
 * Routes:
 *   GET /status                 → public HTML status page
 *   GET /status/api/summary     → live component statuses (JSON)
 *   GET /status/api/incidents   → incident history & post-mortems (JSON)
 *   GET /healthz                → liveness of the status page itself
 */
export function createStatusServer(cfg = loadConfig(), { monitor, logger = console } = {}) {
  const statusMonitor = monitor ?? new StatusMonitor(cfg, { logger });
  let pageCache = null;

  const server = http.createServer(async (req, res) => {
    try {
      if (req.method !== "GET" && req.method !== "HEAD") {
        res.writeHead(405, { allow: "GET, HEAD" });
        return res.end();
      }
      const { pathname } = new URL(req.url, "http://localhost");
      const path = pathname.replace(/\/+$/, "") || "/";

      if (path === "/") {
        res.writeHead(302, { location: "/status" });
        return res.end();
      }
      if (path === "/status") {
        pageCache ??= await readFile(PAGE_PATH, "utf8");
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=60" });
        return res.end(pageCache);
      }
      if (path === "/status/api/summary") {
        return sendJson(res, 200, statusMonitor.snapshot());
      }
      if (path === "/status/api/incidents") {
        const incidents = await loadIncidents(cfg.incidentsFile, logger);
        return sendJson(res, 200, {
          active: incidents.filter((i) => !i.resolvedAt),
          history: incidents.filter((i) => i.resolvedAt),
        });
      }
      if (path === "/healthz") {
        return sendJson(res, 200, { status: "ok", lastCheckedAt: statusMonitor.lastRunAt });
      }
      sendJson(res, 404, { error: "Not found" });
    } catch (err) {
      logger.error?.("[status] request failed", err);
      sendJson(res, 500, { error: "Internal error" });
    }
  });

  server.on("close", () => statusMonitor.stop());
  return { server, monitor: statusMonitor };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const cfg = loadConfig();
  const { server, monitor } = createStatusServer(cfg);
  monitor.start();
  server.listen(cfg.port, () => {
    console.log(`[status] public status page listening on http://0.0.0.0:${cfg.port}/status`);
  });
  const shutdown = () => server.close(() => process.exit(0));
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
