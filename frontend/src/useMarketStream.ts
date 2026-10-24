import { useState, useEffect } from "react";
import { streamMarketUpdates, MarketUpdate } from "./api";

/**
 * Custom hook to stream real-time prediction market updates via Server-Sent Events.
 * Eliminates 3-5 second polling delays and conserves network bandwidth on static markets.
 */
export function useMarketStream(contractId?: string) {
  const [latestUpdate, setLatestUpdate] = useState<MarketUpdate | null>(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const unsub = streamMarketUpdates(
      contractId,
      (update) => {
        setConnected(true);
        setError(null);
        if (update.type !== "connected") {
          setLatestUpdate(update);
        }
      },
      () => {
        setConnected(false);
        setError("Market stream disconnected. Reconnecting...");
      }
    );

    return () => {
      unsub();
      setConnected(false);
    };
  }, [contractId]);

  return { latestUpdate, connected, error };
}
