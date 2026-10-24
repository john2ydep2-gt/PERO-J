import { SorobanRpc } from '@stellar/stellar-sdk';

const BACKEND_BASE_URL = import.meta.env.VITE_BACKEND_URL ?? '';
const SOROBAN_RPC_URL =
  import.meta.env.VITE_SOROBAN_RPC_URL ?? 'https://soroban-testnet.stellar.org';
const CONTRACT_ID = import.meta.env.VITE_CONTRACT_ID ?? '';
const REQUEST_TIMEOUT_MS = 8000;

const FALLBACK_STATUSES = new Set([500, 503]);

export type DataSource = 'backend' | 'on-chain';

type FallbackListener = (source: DataSource) => void;

let currentSource: DataSource = 'backend';
const listeners = new Set<FallbackListener>();

function setSource(source: DataSource): void {
  if (currentSource === source) return;
  currentSource = source;
  listeners.forEach((listener) => listener(source));
}

export function getDataSource(): DataSource {
  return currentSource;
}

export function subscribeDataSource(listener: FallbackListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function withTimeout(signal?: AbortSignal): { signal: AbortSignal; clear: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', () => controller.abort(), { once: true });
  }
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

async function fetchBackend<T>(path: string, init?: RequestInit): Promise<T> {
  const { signal, clear } = withTimeout(init?.signal ?? undefined);
  try {
    const response = await fetch(`${BACKEND_BASE_URL}${path}`, { ...init, signal });
    if (FALLBACK_STATUSES.has(response.status)) {
      throw new Error(`Backend unavailable (${response.status})`);
    }
    if (!response.ok) {
      throw new Error(`Backend request failed (${response.status})`);
    }
    return (await response.json()) as T;
  } finally {
    clear();
  }
}

async function fetchOnChain<T>(method: string, args: unknown[] = []): Promise<T> {
  const server = new SorobanRpc.Server(SOROBAN_RPC_URL);
  const result = await server.simulateTransaction(
    // Minimal contract-state query; callers pass the method and args they need.
    { method, args } as never,
  );
  return result as unknown as T;
}

/**
 * Resilient fetch wrapper: tries the backend API first and transparently
 * falls back to querying contract state directly via Soroban RPC when the
 * backend returns 500/503 or the request times out.
 */
export async function apiFetch<T>(
  path: string,
  options: { init?: RequestInit; rpcMethod?: string; rpcArgs?: unknown[] } = {},
): Promise<T> {
  try {
    const data = await fetchBackend<T>(path, options.init);
    setSource('backend');
    return data;
  } catch (error) {
    if (!options.rpcMethod) throw error;
    const data = await fetchOnChain<T>(options.rpcMethod, options.rpcArgs);
    setSource('on-chain');
    return data;
  }
}
