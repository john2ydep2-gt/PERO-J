import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkCouncilInactivity,
  getCouncilInactivityConfig,
} from '../src/monitors/councilInactivity.js';

const config = {
  routingKey: 'test-routing-key',
  roster: ['GCOUNCIL1', 'GCOUNCIL2', 'GCOUNCIL3'],
  quorum: 2,
};

function disputeWithDeadline(elapsedHours, votes = []) {
  const nowSeconds = 1_800_000_000;
  return {
    id: 17n,
    submission_id: 42n,
    deadline_unix_seconds: BigInt(
      nowSeconds + 72 * 60 * 60 - elapsedHours * 60 * 60,
    ),
    votes,
  };
}

describe('council inactivity monitor', () => {
  it('loads a roster and defaults quorum to a majority', () => {
    assert.deepEqual(
      getCouncilInactivityConfig({
        ORACLE_CONTRACT_ID: 'configured',
        PAGERDUTY_ROUTING_KEY: 'routing-key',
        ORACLE_COUNCIL_ROSTER: 'G1, G2,G3,G3',
      }),
      {
        routingKey: 'routing-key',
        roster: ['G1', 'G2', 'G3'],
        quorum: 2,
      },
    );
  });

  it('rejects a quorum that exceeds the council roster', () => {
    assert.throws(
      () =>
        getCouncilInactivityConfig({
          ORACLE_CONTRACT_ID: 'configured',
          PAGERDUTY_ROUTING_KEY: 'routing-key',
          ORACLE_COUNCIL_ROSTER: 'G1,G2',
          ORACLE_COUNCIL_QUORUM: '3',
        }),
      /ORACLE_COUNCIL_QUORUM/,
    );
  });

  it('dispatches 24h, 48h, and 60h milestones once per dispute', async () => {
    const calls = [];
    const sentAlerts = new Set();
    const fetchImpl = async (url, options) => {
      calls.push({ url, payload: JSON.parse(options.body) });
      return { ok: true };
    };
    const dispute = disputeWithDeadline(60);
    const now = 1_800_000_000 * 1000;

    const sent = await checkCouncilInactivity({
      disputes: [dispute],
      config,
      now,
      fetchImpl,
      sentAlerts,
    });
    const repeated = await checkCouncilInactivity({
      disputes: [dispute],
      config,
      now,
      fetchImpl,
      sentAlerts,
    });

    assert.equal(sent, 3);
    assert.equal(repeated, 0);
    assert.equal(calls.length, 3);
    assert.deepEqual(
      calls.map(
        ({ payload }) => payload.payload.custom_details.hours_without_quorum,
      ),
      [24, 48, 60],
    );
    assert.equal(calls[0].url, 'https://events.pagerduty.com/v2/enqueue');
    assert.equal(calls[0].payload.routing_key, config.routingKey);
    assert.deepEqual(
      calls[0].payload.payload.custom_details.council_roster,
      config.roster,
    );
    assert.equal(calls[2].payload.payload.severity, 'critical');
  });

  it('does not alert before 24 hours or after council quorum is reached', async () => {
    const calls = [];
    const fetchImpl = async (_url, options) => {
      calls.push(options);
      return { ok: true };
    };
    const now = 1_800_000_000 * 1000;

    await checkCouncilInactivity({
      disputes: [
        disputeWithDeadline(23),
        disputeWithDeadline(60, [
          { member: 'GCOUNCIL1' },
          { member: 'GCOUNCIL2' },
        ]),
      ],
      config,
      now,
      fetchImpl,
      sentAlerts: new Set(),
    });

    assert.equal(calls.length, 0);
  });

  it('resolves PagerDuty alerts when the dispute reaches quorum', async () => {
    const calls = [];
    const sentAlerts = new Set();
    const fetchImpl = async (_url, options) => {
      calls.push(JSON.parse(options.body));
      return { ok: true };
    };
    const now = 1_800_000_000 * 1000;

    await checkCouncilInactivity({
      disputes: [disputeWithDeadline(24)],
      config,
      now,
      fetchImpl,
      sentAlerts,
    });
    await checkCouncilInactivity({
      disputes: [
        disputeWithDeadline(25, [
          { member: 'GCOUNCIL1' },
          { member: 'GCOUNCIL2' },
        ]),
      ],
      config,
      now,
      fetchImpl,
      sentAlerts,
    });

    assert.deepEqual(
      calls.map(({ event_action }) => event_action),
      ['trigger', 'resolve'],
    );
    assert.equal(calls[0].dedup_key, calls[1].dedup_key);
    assert.equal(sentAlerts.size, 0);
  });

  it('retries a milestone after PagerDuty rejects the request', async () => {
    const sentAlerts = new Set();
    const disputes = [disputeWithDeadline(24)];
    const options = { disputes, config, now: 1_800_000_000 * 1000, sentAlerts };
    await assert.rejects(
      checkCouncilInactivity({
        ...options,
        fetchImpl: async () => ({
          ok: false,
          status: 500,
          text: async () => 'temporary failure',
        }),
      }),
      /PagerDuty Events API returned 500/,
    );

    const sent = await checkCouncilInactivity({
      ...options,
      fetchImpl: async () => ({ ok: true }),
    });
    assert.equal(sent, 1);
  });
});
