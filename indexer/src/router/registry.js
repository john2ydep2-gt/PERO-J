import { StrKey, scValToNative } from "@stellar/stellar-sdk";
import { db } from "../db.js";
import { decode, evictContractMeta } from "../decoder.js";
import { submitEvent } from "../contract.js";

const handlers = new Map();

function key(domain, action) {
  return JSON.stringify([domain, action]);
}

function eventAction(event) {
  const topic = event.topic?.[0];
  if (!topic) {
    return "unknown";
  }

  try {
    if (typeof topic.sym === "function") {
      return topic.sym();
    }
    const value = scValToNative(topic);
    return typeof value === "symbol" ? (value.description ?? "unknown") : String(value);
  } catch {
    return "unknown";
  }
}

async function persistDecodedEvent(event, context = {}) {
  const decodeEvent = context.decodeEvent ?? decode;
  const database = context.database ?? db;
  const submit = context.submitOnchain === false ? async () => null : (context.submit ?? submitEvent);
  const logger = context.logger ?? console;
  const decoded = await decodeEvent(event);
  const onchainSeq = await submit(decoded);
  if (onchainSeq !== null) {
    decoded.onchain_seq = onchainSeq;
  }
  await database.upsertEvent(decoded);
  logger.log?.(`[${event.ledger}] ${decoded.function}: ${decoded.description}`);
  return decoded;
}

export function registerEventHandler(domain, action, handler) {
  if (typeof domain !== "string" || !domain || typeof action !== "string" || !action) {
    throw new TypeError("Event handler domain and action must be non-empty strings");
  }
  if (typeof handler !== "function") {
    throw new TypeError("Event handler must be a function");
  }

  const handlerKey = key(domain, action);
  const previous = handlers.get(handlerKey);
  handlers.set(handlerKey, handler);
  return () => {
    if (handlers.get(handlerKey) === handler) {
      if (previous) {
        handlers.set(handlerKey, previous);
      } else {
        handlers.delete(handlerKey);
      }
    }
  };
}

export function isExplorerUpdateEvent(event) {
  const explorerContractId = process.env.SOROBAN_EXPLORER_CONTRACT_ID;
  return Boolean(
    explorerContractId &&
      event.contractId === explorerContractId &&
      eventAction(event) === "update"
  );
}

export function updateEventContractId(event) {
  try {
    const bytes = event.topic?.[1]?.bytes();
    return bytes ? StrKey.encodeContract(bytes) : null;
  } catch {
    return null;
  }
}

async function handleExplorerUpdate(event) {
  const contractId = updateEventContractId(event);
  if (contractId) {
    evictContractMeta(contractId);
  }
}

export async function dispatchContractEvent(event, context = {}) {
  const domain = event.contractId ?? "unknown";
  const action = eventAction(event);
  const handler =
    handlers.get(key(domain, action)) ??
    handlers.get(key(domain, "*")) ??
    handlers.get(key("*", action));

  if (isExplorerUpdateEvent(event)) {
    return handleExplorerUpdate(event);
  }
  if (handler) {
    return handler(event, context);
  }

  const logger = context.logger ?? console;
  logger.warn?.("[router] Unregistered contract event", {
    domain,
    action,
    ledger: event.ledger,
    txHash: event.txHash ?? null,
    fallback: "decode-and-persist",
  });
  return persistDecodedEvent(event, context);
}
