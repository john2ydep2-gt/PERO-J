import { useEffect, useRef, useState } from "react";

export type ConnectionStatus = "live" | "reconnecting" | "offline";

/**
 * Tracks network + SSE connection status.
 *
 * - `"offline"`:      navigator.onLine is false (no network at all)
 * - `"reconnecting"`: online but SSE has errored / is retrying
 * - `"live"`:         online and SSE connection is healthy
 *
 * @param sseUrl  The SSE endpoint URL.  When omitted only navigator.onLine is
 *                used and the status will be either "live" or "offline".
 */
export function useNetworkStatus(sseUrl?: string): ConnectionStatus {
  const [online, setOnline] = useState<boolean>(
    typeof navigator !== "undefined" ? navigator.onLine : true
  );
  const [sseOk, setSseOk] = useState<boolean>(true);
  const esRef = useRef<EventSource | null>(null);

  // --- navigator.onLine listeners ---
  useEffect(() => {
    const handleOnline = () => setOnline(true);
    const handleOffline = () => setOnline(false);
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, []);

  // --- SSE health ---
  useEffect(() => {
    if (!sseUrl) return;

    function connect() {
      const es = new EventSource(sseUrl as string);
      esRef.current = es;

      // Any message means the connection is healthy
      es.onmessage = () => setSseOk(true);

      es.addEventListener("open", () => setSseOk(true));

      es.onerror = () => {
        setSseOk(false);
        // EventSource retries automatically; we don't need to reconnect manually.
      };
    }

    connect();

    return () => {
      esRef.current?.close();
      esRef.current = null;
    };
  }, [sseUrl]);

  if (!online) return "offline";
  if (!sseOk) return "reconnecting";
  return "live";
}
