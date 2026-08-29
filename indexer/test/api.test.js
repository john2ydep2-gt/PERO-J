/**
 * Tests for src/api.js error handling middleware.
 *
 * api.js imports from index.js (which previously auto-started the indexer).
 * The run() call in index.js is now guarded so that importing api.js in a
 * test environment does not start the server or indexer loop.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { errorHandler, validateContractPayload } from "../src/api.js";

const VALID_CONTRACT_ID = `C${"A".repeat(55)}`;

function createMockRes() {
  return {
    statusCode: null,
    body: null,
    headersSent: false,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(data) {
      this.body = data;
      return this;
    },
    send() {
      return this;
    },
  };
}

describe("errorHandler middleware", () => {
  let originalError;
  let consoleOutput;

  beforeEach(() => {
    originalError = console.error;
    consoleOutput = [];
    console.error = (...args) => consoleOutput.push(args);
  });

  afterEach(() => {
    console.error = originalError;
  });

  it("returns 500 with { error: message } for unhandled errors", () => {
    const err = new Error("Something went wrong");
    const req = { method: "GET", path: "/api/events" };
    const res = createMockRes();

    errorHandler(err, req, res, () => {});

    assert.equal(res.statusCode, 500);
    assert.deepEqual(res.body, { error: "Something went wrong" });
  });

  it("falls back to Internal Server Error when err.message is empty", () => {
    const err = Object.assign(new Error(""), { message: "" });
    const req = { method: "GET", path: "/api/events" };
    const res = createMockRes();

    errorHandler(err, req, res, () => {});

    assert.equal(res.statusCode, 500);
    assert.deepEqual(res.body, { error: "Internal Server Error" });
  });

  it("logs request method, path, and stack trace", () => {
    const err = new Error("Boom");
    const req = { method: "POST", path: "/api/contracts" };
    const res = createMockRes();

    errorHandler(err, req, res, () => {});

    assert.equal(consoleOutput.length, 1, "expected one console.error call");
    const [label, details] = consoleOutput[0];
    assert.equal(label, "API Error:");
    assert.equal(details.method, "POST");
    assert.equal(details.path, "/api/contracts");
    assert.ok(details.stack, "expected stack trace in log output");
  });

  it("does not send a response when headers are already sent", () => {
    const err = new Error("Boom");
    const req = { method: "GET", path: "/api/events" };
    const res = createMockRes();
    res.headersSent = true;
    let statusCalled = false;
    res.status = () => {
      statusCalled = true;
      return res;
    };
    let jsonCalled = false;
    res.json = () => {
      jsonCalled = true;
      return res;
    };

    errorHandler(err, req, res, () => {});

    assert.equal(statusCalled, false, "should not call res.status() when headersSent");
    assert.equal(jsonCalled, false, "should not call res.json() when headersSent");
  });
});

describe("validateContractPayload", () => {
  it("requires id", () => {
    const err = validateContractPayload({ name: "Foo" });
    assert.equal(err, "id is required");
  });

  it("rejects an id that does not match the contract strkey pattern", () => {
    const err = validateContractPayload({ id: "not-a-valid-id", name: "Foo" });
    assert.equal(err, "id is required");
  });

  it("requires name", () => {
    const err = validateContractPayload({ id: VALID_CONTRACT_ID });
    assert.equal(err, "name is required");
  });

  it("rejects a blank name", () => {
    const err = validateContractPayload({ id: VALID_CONTRACT_ID, name: "   " });
    assert.equal(err, "name is required");
  });

  it("rejects functions that are not an array", () => {
    const err = validateContractPayload({
      id: VALID_CONTRACT_ID,
      name: "Foo",
      functions: "not-an-array",
    });
    assert.equal(err, "functions must be an array");
  });

  it("accepts a valid payload", () => {
    const err = validateContractPayload({
      id: VALID_CONTRACT_ID,
      name: "Foo",
      functions: [],
    });
    assert.equal(err, null);
  });
});
