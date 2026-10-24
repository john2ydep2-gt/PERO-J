import {
  Account,
  Contract,
  Networks,
  SorobanRpc,
  TransactionBuilder,
} from '@stellar/stellar-sdk';
import { scValToJs } from './scval.js';

const RPC_URL =
  process.env.SOROBAN_RPC_URL || 'https://soroban-testnet.stellar.org';
const NETWORK_PASSPHRASE = process.env.NETWORK_PASSPHRASE || Networks.TESTNET;
const SOURCE_ACCOUNT =
  process.env.OPERATIONAL_ACCOUNT ||
  'GCFIRY65OQE7DFP5KLNS2PF2LVZMUZYJX4OZIEQ36N2IQANUB5XVYOJR';
const rpc = new SorobanRpc.Server(RPC_URL, { allowHttp: true });

async function fetchActive() {
  const contractId = process.env.ORACLE_CONTRACT_ID;
  if (!contractId) {
    throw new Error('ORACLE_CONTRACT_ID is not configured');
  }

  const tx = new TransactionBuilder(new Account(SOURCE_ACCOUNT, '0'), {
    fee: '100',
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(new Contract(contractId).call('get_active_disputes'))
    .setTimeout(30)
    .build();

  const result = await rpc.simulateTransaction(tx);
  if (SorobanRpc.Api.isSimulationError(result)) {
    throw new Error(`get_active_disputes simulation failed: ${result.error}`);
  }

  const value = result.result?.retval ? scValToJs(result.result.retval) : null;
  if (!Array.isArray(value)) {
    throw new Error('get_active_disputes must return an array');
  }
  return value;
}

function requiredString(value, field) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Invalid dispute field: ${field}`);
  }
  return value;
}

function integerString(value, field) {
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (typeof value === 'number' && Number.isSafeInteger(value)) {
    return String(value);
  }
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    return value;
  }
  throw new Error(`Invalid dispute field: ${field}`);
}

function formatCountdown(seconds) {
  if (seconds <= 0) return '0 seconds';

  const units = [
    ['day', 86_400],
    ['hour', 3_600],
    ['minute', 60],
    ['second', 1],
  ];
  let remaining = seconds;
  const parts = [];

  for (const [unit, size] of units) {
    const count = Math.floor(remaining / size);
    if (count > 0) {
      parts.push(`${count} ${unit}${count === 1 ? '' : 's'}`);
      remaining %= size;
    }
    if (parts.length === 2) break;
  }

  return parts.join(' ');
}

export function formatOracleDisputes(rows, now = Date.now()) {
  if (!Array.isArray(rows)) {
    throw new Error('Oracle disputes must be an array');
  }

  return rows.map((row) => {
    const deadlineSeconds = Number(
      integerString(row.deadline_unix_seconds, 'deadline_unix_seconds'),
    );
    const deadlineMs = deadlineSeconds * 1000;
    if (
      !Number.isSafeInteger(deadlineSeconds) ||
      !Number.isFinite(deadlineMs) ||
      !Number.isFinite(new Date(deadlineMs).getTime())
    ) {
      throw new Error('Invalid dispute field: deadline_unix_seconds');
    }

    if (!Array.isArray(row.votes)) {
      throw new Error('Invalid dispute field: votes');
    }

    const votes = row.votes.map((vote) => {
      const decision = requiredString(vote.vote, 'votes[].vote').toLowerCase();
      if (decision !== 'affirmative' && decision !== 'negative') {
        throw new Error(
          'Invalid dispute vote; expected Affirmative or Negative',
        );
      }
      return {
        member: requiredString(vote.member, 'votes[].member'),
        vote: decision,
      };
    });
    const remainingSeconds = Math.max(
      0,
      deadlineSeconds - Math.floor(now / 1000),
    );

    return {
      id: integerString(row.id, 'id'),
      submission_id: integerString(row.submission_id, 'submission_id'),
      asserted_outcome: requiredString(
        row.asserted_outcome,
        'asserted_outcome',
      ),
      disputer: requiredString(row.disputer, 'disputer'),
      affirmative_votes: votes.filter((vote) => vote.vote === 'affirmative')
        .length,
      negative_votes: votes.filter((vote) => vote.vote === 'negative').length,
      votes,
      deadline: new Date(deadlineMs).toISOString(),
      remaining_seconds: remainingSeconds,
      remaining_time: formatCountdown(remainingSeconds),
    };
  });
}

export const oracleDisputes = { fetchActive };
