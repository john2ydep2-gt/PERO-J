import { useCallback } from "react";
import { parseContractError } from "../lib/contract-errors";
import { useToast } from "../components/Toast";

/**
 * Returns a `handleContractError` function.
 * Call it with any thrown error; if it matches a known Soroban contract error
 * code (21–28) a friendly toast is shown. Otherwise the error is re-thrown so
 * callers can handle unexpected failures themselves.
 *
 * @example
 * const handleContractError = useContractError();
 *
 * try {
 *   await someContractCall();
 * } catch (err) {
 *   handleContractError(err);
 * }
 */
export function useContractError() {
  const { addToast } = useToast();

  return useCallback(
    (err: unknown) => {
      const raw = err instanceof Error ? err.message : String(err);
      const info = parseContractError(raw);

      if (info) {
        addToast({
          variant: "error",
          title: info.message,
          body: info.resolution,
          duration: 8000,
        });
        return; // handled
      }

      // Unknown error — re-throw so the caller can deal with it
      throw err;
    },
    [addToast]
  );
}
