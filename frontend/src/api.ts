const BASE = import.meta.env.VITE_API_URL || "/api";
const SOROBAN_RPC_URL = import.meta.env.VITE_SOROBAN_RPC_URL || "https://soroban-testnet.stellar.org";
const CONTRACT_ID = import.meta.env.VITE_CONTRACT_ID || "";

export interface DecodedEvent {
  seq: number;
  contract_id: string;
  function: string;
  ledger: number;
  description: string;
  raw_topics: string[];
  raw_data?: string;
  tx_hash?: string;
  created_at?: string;
  sac_asset?: string;
  onchain_seq?: number | null;
}

export interface ContractMeta {
  id: string;
  name: string;
  description: string;
  functions: { name: string; description: string }[];
  registered_by?: string;
  created_at?: string;
  event_count?: number;
}

export interface WalletEventsResponse {
  events: DecodedEvent[];
  total: number;
  page: number;
  limit: number;
}

export interface EventsResponse {
  events: DecodedEvent[];
  total: number;
  page: number;
  limit: number;
}

export interface ContractsResponse {
  contracts: ContractMeta[];
  total: number;
  page: number;
  limit: number;
}

export interface ProposedOutcome {
  id: string;
  contract_id: string;
  outcome: string;
  proposer: string;
  proposed_at: string;
  challenge_deadline: string;
  disputer_bond: string;
  challenge_reward: string;
  status: "proposed" | "challenged" | "finalized";
}

export interface ChallengeResponse {
  ok: boolean;
  tx_hash?: string;
  outcome: ProposedOutcome;
}

export interface CouncilVote {
  voter: string;
  vote: "uphold" | "overturn" | "abstain";
  cast_at: string;
}

export interface DisputeEvidence {
  label: string;
  url: string;
}

export interface DisputeTimelineEntry {
  at: string;
  actor: string;
  action: string;
  detail?: string;
}

export interface DisputeDetail {
  market_id: string;
  status: "proposed" | "challenged" | "finalized";
  submitter: string;
  proposed_outcome: string;
  submitter_bond: string;
  challenger?: string;
  disputed_outcome?: string;
  challenger_bond?: string;
  council_votes: CouncilVote[];
  council_size: number;
  resolution_deadline?: string;
  evidence: DisputeEvidence[];
  timeline: DisputeTimelineEntry[];
}

export class ApiError extends Error {
  status: number;

  constructor(status: number, path: string) {
    super(`API ${status}: ${path}`);
    this.name = "ApiError";
    this.status = status;
  }
}

/**
 * Tracks whether the client is currently operating in direct on-chain mode
 * because the backend API is unavailable. Consumers can subscribe to render
 * a non-intrusive warning banner.
 */
let onChainMode = false;
const onChainModeListeners = new Set<(active: boolean) => void>();

export function isOnChainMode(): boolean {
  return onChainMode;
}

export function subscribeOnChainMode(listener: (active: boolean) => void): () => void {
  onChainModeListeners.add(listener);
  listener(onChainMode);
  return () => {
    onChainModeListeners.delete(listener);
  };
}

function setOnChainMode(active: boolean): void {
  if (onChainMode === active) return;
  onChainMode = active;
  onChainModeListeners.forEach((listener) => listener(active));
}

function isFailoverStatus(status: number): boolean {
  return status === 500 || status === 503;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);

  try {
    const res = await fetch(BASE + path, { ...init, signal: controller.signal });
    if (!res.ok) throw new ApiError(res.status, path);
    setOnChainMode(false);
    return await res.json();
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("Request timed out");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function get<T>(path: string): Promise<T> {
  return request<T>(path);
}

async function post<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/**
 * Query contract state directly via Soroban RPC. Used as a transparent
 * fallback when the backend API is down but the chain is operational.
 */
async function sorobanRpc<T>(method: string, params: unknown): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);

  try {
    const res = await fetch(SOROBAN_RPC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: controller.signal,
    });
    if (!res.ok) throw new ApiError(res.status, method);
    const json = await res.json();
    if (json.error) throw new Error(json.error.message || "Soroban RPC error");
    return json.result as T;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Resilient fetch wrapper: tries the backend endpoint first and transparently
 * falls back to querying contract state directly via Soroban RPC on HTTP
 * 500/503 or network timeout. Returns the fallback result when available.
 */
async function resilientGet<T>(path: string, fallback: () => Promise<T>): Promise<T> {
  try {
    return await get<T>(path);
  } catch (error) {
    const shouldFailover =
      (error instanceof ApiError && isFailoverStatus(error.status)) ||
      (error instanceof Error && error.message === "Request timed out") ||
      error instanceof TypeError;
    if (!shouldFailover) throw error;
    const result = await fallback();
    setOnChainMode(true);
    return result;
  }
}

async function fetchOnChainOutcome(id: string): Promise<ProposedOutcome> {
  const result = await sorobanRpc<{ xdr: string }>("getLedgerEntries", {
    keys: [{ contract: CONTRACT_ID, key: id }],
  });
  return JSON.parse(atob(result.xdr)) as ProposedOutcome;
}

async function fetchOnChainDispute(marketId: string): Promise<DisputeDetail> {
  const result = await sorobanRpc<{ xdr: string }>("getLedgerEntries", {
    keys: [{ contract: CONTRACT_ID, key: marketId }],
  });
  return JSON.parse(atob(result.xdr)) as DisputeDetail;
}

/**
 * Connect to the Server-Sent Events stream for live event updates.
 *
 * @param onEvent Callback invoked when a new DecodedEvent is streamed
 * @param onError Optional error handler callback
 * @returns Cleanup function that closes the EventSource connection
 */
export function streamEvents(
  onEvent: (event: DecodedEvent) => void,
  onError?: (err: Event) => void
): () => void {
  const url = `${BASE}/events/stream`;
  const eventSource = new EventSource(url);

  eventSource.onmessage = (e) => {
    try {
      const data: DecodedEvent = JSON.parse(e.data);
      onEvent(data);
    } catch (err) {
      console.error("Failed to parse SSE event:", err);
    }
  };

  if (onError) {
    eventSource.onerror = onError;
  }

  return () => {
    eventSource.close();
  };
}


export interface MarketUpdate {
  contractId?: string;
  type: string;
  data?: Record<string, unknown>;
  timestamp?: number;
}

/**
 * Connect to the Server-Sent Events stream for real-time market updates.
 * Eliminates 3-5s polling latency and saves bandwidth on static markets.
 */
export function streamMarketUpdates(
  contractId: string | undefined,
  onUpdate: (update: MarketUpdate) => void,
  onError?: (err: Event) => void
): () => void {
  const q = contractId ? `?contract=${encodeURIComponent(contractId)}` : "";
  const url = `${BASE}/markets/stream${q}`;
  const eventSource = new EventSource(url);

  eventSource.onmessage = (e) => {
    try {
      const data: MarketUpdate = JSON.parse(e.data);
      onUpdate(data);
    } catch (err) {
      console.error("Failed to parse market update SSE frame:", err);
    }
  };

  if (onError) {
    eventSource.onerror = onError;
  }

  return () => {
    eventSource.close();
  };
}
export const api = {
  distinctFunctions: () => get<string[]>("/functions"),
  events: (params: { contract?: string; fn?: string; q?: string; page?: number }) => {
    const q = new URLSearchParams();
    if (params.contract) q.set("contract", params.contract);
    if (params.fn)       q.set("fn", params.fn);
    if (params.q)        q.set("q", params.q);
    if (params.page)     q.set("page", String(params.page));
    return get<EventsResponse>(`/events?${q}`);
  },
  event:            (seq: number)                         => get<DecodedEvent>(`/events/${seq}`),
  contracts:        (params: { q?: string; page?: number; limit?: number }) => {
    const q = new URLSearchParams();
    if (params.q)       q.set("q", params.q);
    if (params.page)    q.set("page", String(params.page));
    if (params.limit)   q.set("limit", String(params.limit));
    return get<ContractsResponse>(`/contracts?${q}`);
  },
  contract:         (id: string)                          => get<ContractMeta>(`/contracts/${id}`),
  wallet:           (address: string, page: number = 1)   => get<WalletEventsResponse>(`/wallet/${address}?page=${page}`),
  registerContract: (meta: ContractMeta)                  => post<{ ok: boolean }>("/contracts", meta),
  proposedOutcome:  (id: string)                          =>
    resilientGet<ProposedOutcome>(`/outcomes/${id}`, () => fetchOnChainOutcome(id)),
  challengeOutcome: (id: string, payload: { challenger: string; bond: string; signed_xdr: string }) =>
    post<ChallengeResponse>(`/outcomes/${id}/challenge`, payload),
  dispute:          (marketId: string)                    =>
    resilientGet<DisputeDetail>(`/disputes/${marketId}`, () => fetchOnChainDispute(marketId)),
  streamEvents,
  streamMarketUpdates,
};
