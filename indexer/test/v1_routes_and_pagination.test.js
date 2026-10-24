import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/api.js";
import { db, encodeCursor, decodeCursor } from "../src/db.js";

describe("REST API /api/v1 normalization & 301 redirects (issue #965)", () => {
  it("redirects legacy /api/events with 301 Moved Permanently to /api/v1/events", async () => {
    const app = createApp();
    const server = app.listen(0);
    const { port } = server.address();

    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/events?limit=5`, {
        redirect: "manual",
      });

      assert.equal(res.status, 301, "expected 301 redirect");
      const location = res.headers.get("location");
      assert.ok(location, "expected Location header");
      assert.equal(location, "/api/v1/events?limit=5");
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("redirects legacy /api/leaderboard with 301 to /api/v1/leaderboard", async () => {
    const app = createApp();
    const server = app.listen(0);
    const { port } = server.address();

    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/leaderboard`, {
        redirect: "manual",
      });

      assert.equal(res.status, 301);
      assert.equal(res.headers.get("location"), "/api/v1/leaderboard");
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("responds directly with 200 OK under /api/v1 namespace", async () => {
    const originalGetEvents = db.getEvents;
    db.getEvents = async () => ({ events: [], next_cursor: null, total: 0, page: 1, limit: 10 });

    const app = createApp();
    const server = app.listen(0);
    const { port } = server.address();

    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/v1/events`);
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.ok(Array.isArray(data.events));
      assert.equal(data.next_cursor, null);
    } finally {
      db.getEvents = originalGetEvents;
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

describe("Cursor-based pagination (issue #966)", () => {
  it("encodes and decodes opaque pagination cursors", () => {
    const item = { id: "mkt-123", created_at: "2026-10-22T10:00:00.000Z" };
    const cursor = encodeCursor(item);
    assert.ok(typeof cursor === "string" && cursor.length > 0);

    const decoded = decodeCursor(cursor);
    assert.equal(decoded.id, "mkt-123");
    assert.equal(decoded.time, "2026-10-22T10:00:00.000Z");
  });

  it("returns next_cursor on markets endpoint when more pages exist", async () => {
    const originalGetMarkets = db.getMarkets;
    db.getMarkets = async ({ limit, cursor }) => {
      const dummyMarkets = [
        { id: "m1", question: "Will XLM exceed $1?", created_at: "2026-10-22T12:00:00.000Z" },
        { id: "m2", question: "Will Soroban v23 deploy?", created_at: "2026-10-22T11:00:00.000Z" },
      ];
      const next_cursor = encodeCursor(dummyMarkets[1]);
      return { markets: dummyMarkets, items: dummyMarkets, next_cursor, total: 10, limit, page: 1 };
    };

    const app = createApp();
    const server = app.listen(0);
    const { port } = server.address();

    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/v1/markets?limit=2`);
      assert.equal(res.status, 200);
      const body = await res.json();

      assert.equal(body.markets.length, 2);
      assert.ok(typeof body.next_cursor === "string");

      const decoded = decodeCursor(body.next_cursor);
      assert.equal(decoded.id, "m2");
    } finally {
      db.getMarkets = originalGetMarkets;
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("returns next_cursor on bets endpoint and supports filtering by market_id", async () => {
    const originalGetBets = db.getBets;
    db.getBets = async ({ market_id, limit, cursor }) => {
      const dummyBets = [
        { id: "b1", market_id, amount: 100, outcome: "YES", created_at: "2026-10-22T12:00:00.000Z" },
      ];
      return { bets: dummyBets, items: dummyBets, next_cursor: null, total: 1, limit, page: 1 };
    };

    const app = createApp();
    const server = app.listen(0);
    const { port } = server.address();

    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/v1/bets?market_id=m1&limit=1`);
      assert.equal(res.status, 200);
      const body = await res.json();

      assert.equal(body.bets.length, 1);
      assert.equal(body.bets[0].market_id, "m1");
      assert.equal(body.next_cursor, null);
    } finally {
      db.getBets = originalGetBets;
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("maintains backward compatibility with page and limit queries", async () => {
    const originalGetLeaderboard = db.getLeaderboard;
    db.getLeaderboard = async (opts) => {
      return {
        items: [{ contract_id: "C1", name: "DEX", event_count: 50 }],
        leaderboard: [{ contract_id: "C1", name: "DEX", event_count: 50 }],
        next_cursor: null,
        limit: 10,
        page: 2,
      };
    };

    const app = createApp();
    const server = app.listen(0);
    const { port } = server.address();

    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/v1/leaderboard?page=2&limit=10`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.ok(body.items || body.leaderboard);
    } finally {
      db.getLeaderboard = originalGetLeaderboard;
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
