const DISPUTE_VOTING_PERIOD_SECONDS = 72 * 60 * 60;
const ESCALATION_HOURS = [24, 48, 60];
export const COUNCIL_INACTIVITY_CHECK_INTERVAL_MS = 60 * 60 * 1000;

const notifiedMilestones = new Set();

function parseInteger(value, field) {
  if (typeof value === 'bigint' && value >= 0n) {
    return value;
  }
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
    return BigInt(value);
  }
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    return BigInt(value);
  }
  throw new Error(`Invalid dispute field: ${field}`);
}

function requiredString(value, field) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Invalid dispute field: ${field}`);
  }
  return value;
}

function getVotingMembers(dispute, roster) {
  if (!Array.isArray(dispute.votes)) {
    throw new Error('Invalid dispute field: votes');
  }
  const council = new Set(roster);
  return new Set(
    dispute.votes
      .map((vote) => {
        if (vote === null || typeof vote !== 'object') {
          throw new Error('Invalid dispute field: votes[]');
        }
        return requiredString(vote.member, 'votes[].member');
      })
      .filter((member) => council.has(member)),
  );
}

export function getCouncilInactivityConfig(env = process.env) {
  const routingKey = env.PAGERDUTY_ROUTING_KEY?.trim();
  const roster = (env.ORACLE_COUNCIL_ROSTER || '')
    .split(',')
    .map((member) => member.trim())
    .filter(Boolean);
  const uniqueRoster = [...new Set(roster)];

  if (!routingKey || !env.ORACLE_CONTRACT_ID || uniqueRoster.length === 0) {
    return null;
  }

  const configuredQuorum = env.ORACLE_COUNCIL_QUORUM;
  const quorum =
    configuredQuorum === undefined || configuredQuorum.trim() === ''
      ? Math.floor(uniqueRoster.length / 2) + 1
      : Number(configuredQuorum);
  if (!Number.isInteger(quorum) || quorum < 1 || quorum > uniqueRoster.length) {
    throw new Error(
      'ORACLE_COUNCIL_QUORUM must be an integer between 1 and the council roster size',
    );
  }

  return { routingKey, roster: uniqueRoster, quorum };
}

function dueMilestones(dispute, config, nowSeconds) {
  const id = parseInteger(dispute.id, 'id').toString();
  const deadline = parseInteger(
    dispute.deadline_unix_seconds,
    'deadline_unix_seconds',
  );
  const deadlineSeconds = Number(deadline);
  const deadlineMs = deadlineSeconds * 1000;
  if (
    !Number.isSafeInteger(deadlineSeconds) ||
    !Number.isFinite(deadlineMs) ||
    !Number.isFinite(new Date(deadlineMs).getTime())
  ) {
    throw new Error('Invalid dispute field: deadline_unix_seconds');
  }

  const votingMembers = getVotingMembers(dispute, config.roster);
  if (votingMembers.size >= config.quorum) {
    return [];
  }

  const elapsedSeconds =
    BigInt(nowSeconds) - (deadline - BigInt(DISPUTE_VOTING_PERIOD_SECONDS));
  return ESCALATION_HOURS.filter(
    (hours) => elapsedSeconds >= BigInt(hours * 60 * 60),
  ).map((hours) => ({
    disputeId: id,
    submissionId: parseInteger(
      dispute.submission_id,
      'submission_id',
    ).toString(),
    hours,
    votesCast: votingMembers.size,
    deadline: deadline.toString(),
  }));
}

async function resolvePagerDutyAlert(alertKey, config, fetchImpl) {
  const response = await fetchImpl('https://events.pagerduty.com/v2/enqueue', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      routing_key: config.routingKey,
      event_action: 'resolve',
      dedup_key: `peroj-oracle-dispute-${alertKey.replace(':', '-council-inactivity-')}h`,
    }),
  });

  if (!response.ok) {
    const responseBody = await response.text();
    throw new Error(
      `PagerDuty Events API returned ${response.status}: ${responseBody}`,
    );
  }
}

async function dispatchPagerDutyAlert(alert, config, fetchImpl) {
  const response = await fetchImpl('https://events.pagerduty.com/v2/enqueue', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      routing_key: config.routingKey,
      event_action: 'trigger',
      dedup_key: `peroj-oracle-dispute-${alert.disputeId}-council-inactivity-${alert.hours}h`,
      payload: {
        summary: `Oracle dispute ${alert.disputeId} has no council quorum after ${alert.hours} hours`,
        source: 'PERO-J Oracle council inactivity monitor',
        severity: alert.hours >= 60 ? 'critical' : 'warning',
        timestamp: new Date().toISOString(),
        component: 'oracle',
        group: 'council',
        class: 'council-inactivity',
        custom_details: {
          dispute_id: alert.disputeId,
          submission_id: alert.submissionId,
          hours_without_quorum: alert.hours,
          votes_cast: alert.votesCast,
          quorum: config.quorum,
          council_roster: config.roster,
          voting_deadline: new Date(
            Number(alert.deadline) * 1000,
          ).toISOString(),
        },
      },
    }),
  });

  if (!response.ok) {
    const responseBody = await response.text();
    throw new Error(
      `PagerDuty Events API returned ${response.status}: ${responseBody}`,
    );
  }
}

export async function checkCouncilInactivity({
  disputes,
  config,
  now = Date.now(),
  fetchImpl = fetch,
  sentAlerts = notifiedMilestones,
}) {
  if (!Array.isArray(disputes)) {
    throw new Error('Active Oracle disputes must be an array');
  }
  const nowSeconds = Math.floor(now / 1000);
  const activeDisputes = new Map(
    disputes.map((dispute) => {
      const id = parseInteger(dispute.id, 'id').toString();
      const votes = getVotingMembers(dispute, config.roster);
      return [id, votes.size >= config.quorum];
    }),
  );
  let sentCount = 0;

  for (const alertKey of sentAlerts) {
    const [disputeId] = alertKey.split(':');
    if (!activeDisputes.has(disputeId) || activeDisputes.get(disputeId)) {
      await resolvePagerDutyAlert(alertKey, config, fetchImpl);
      sentAlerts.delete(alertKey);
    }
  }

  for (const dispute of disputes) {
    for (const alert of dueMilestones(dispute, config, nowSeconds)) {
      const key = `${alert.disputeId}:${alert.hours}`;
      if (sentAlerts.has(key)) {
        continue;
      }
      await dispatchPagerDutyAlert(alert, config, fetchImpl);
      sentAlerts.add(key);
      sentCount++;
    }
  }

  return sentCount;
}

export function startCouncilInactivityMonitor({
  fetchActive,
  config,
  logger = console,
}) {
  let stopped = false;
  let timeout;

  const check = async () => {
    if (stopped) {
      return;
    }
    try {
      const disputes = await fetchActive();
      const sentCount = await checkCouncilInactivity({ disputes, config });
      if (sentCount > 0) {
        logger.info(
          `[oracle monitor] dispatched ${sentCount} council alert(s)`,
        );
      }
    } catch (error) {
      logger.error('[oracle monitor] council inactivity check failed:', error);
    }
    if (!stopped) {
      timeout = setTimeout(check, COUNCIL_INACTIVITY_CHECK_INTERVAL_MS);
    }
  };

  void check();
  return () => {
    stopped = true;
    clearTimeout(timeout);
  };
}
