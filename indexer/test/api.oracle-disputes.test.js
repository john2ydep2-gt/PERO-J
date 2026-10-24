import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { SorobanRpc, StrKey, xdr } from '@stellar/stellar-sdk';
import { createApp } from '../src/api.js';
import { oracleDisputes } from '../src/oracleDisputes.js';

describe('GET /api/v1/oracle/disputes', () => {
  let server;
  let baseUrl;
  let originalFetchActive;
  let originalOracleContractId;

  beforeEach(async () => {
    originalFetchActive = oracleDisputes.fetchActive;
    originalOracleContractId = process.env.ORACLE_CONTRACT_ID;
    process.env.ORACLE_CONTRACT_ID = 'configured-for-test';
    const app = createApp();
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  afterEach(async () => {
    oracleDisputes.fetchActive = originalFetchActive;
    if (originalOracleContractId === undefined) {
      delete process.env.ORACLE_CONTRACT_ID;
    } else {
      process.env.ORACLE_CONTRACT_ID = originalOracleContractId;
    }
    if (server) await new Promise((resolve) => server.close(resolve));
  });

  it('returns active dispute details, vote tallies, and a human-readable countdown', async () => {
    const deadlineSeconds = Math.floor(Date.now() / 1000) + 90_061;
    oracleDisputes.fetchActive = async () => [
      {
        id: 7n,
        submission_id: 42n,
        asserted_outcome: 'valid',
        disputer: 'GDISPUTER',
        deadline_unix_seconds: BigInt(deadlineSeconds),
        votes: [
          { member: 'GCOUNCIL1', vote: 'Affirmative' },
          { member: 'GCOUNCIL2', vote: 'Affirmative' },
          { member: 'GCOUNCIL3', vote: 'Negative' },
        ],
      },
    ];

    const response = await fetch(`${baseUrl}/api/v1/oracle/disputes`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const body = await response.json();
    assert.equal(body.disputes.length, 1);
    assert.equal(body.disputes[0].id, '7');
    assert.equal(body.disputes[0].submission_id, '42');
    assert.equal(body.disputes[0].asserted_outcome, 'valid');
    assert.equal(body.disputes[0].disputer, 'GDISPUTER');
    assert.equal(body.disputes[0].affirmative_votes, 2);
    assert.equal(body.disputes[0].negative_votes, 1);
    assert.equal(body.disputes[0].votes.length, 3);
    assert.equal(body.disputes[0].votes[0].member, 'GCOUNCIL1');
    assert.equal(body.disputes[0].votes[0].vote, 'affirmative');
    assert.equal(
      body.disputes[0].deadline,
      new Date(deadlineSeconds * 1000).toISOString(),
    );
    assert.match(
      body.disputes[0].remaining_time,
      /\d+ (day|hour|minute|second)/,
    );
  });

  it('fetches active disputes through the Soroban view simulation', async () => {
    const originalSimulate = SorobanRpc.Server.prototype.simulateTransaction;
    let simulatedTransaction;
    SorobanRpc.Server.prototype.simulateTransaction = async (transaction) => {
      simulatedTransaction = transaction;
      return { result: { retval: xdr.ScVal.scvVec([]) } };
    };
    process.env.ORACLE_CONTRACT_ID = StrKey.encodeContract(Buffer.alloc(32, 9));

    try {
      assert.deepEqual(await oracleDisputes.fetchActive(), []);
      assert.ok(simulatedTransaction);
    } finally {
      SorobanRpc.Server.prototype.simulateTransaction = originalSimulate;
    }
  });

  it('returns 503 when the Oracle contract is not configured', async () => {
    delete process.env.ORACLE_CONTRACT_ID;

    const response = await fetch(`${baseUrl}/api/v1/oracle/disputes`);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), {
      error: 'Oracle contract is not configured',
    });
  });
});
