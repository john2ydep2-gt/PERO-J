import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, type ContractMeta } from "./api";

function mockFetchUntilAborted(stallWhileParsing = false) {
  const abort = (signal?: AbortSignal) =>
    new Promise<never>((_resolve, reject) => {
      signal?.addEventListener(
        "abort",
        () =>
          reject(Object.assign(new Error("Aborted"), { name: "AbortError" })),
        { once: true },
      );
    });
  const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
    if (stallWhileParsing) {
      return Promise.resolve({
        ok: true,
        json: () => abort(init?.signal),
      } as unknown as Response);
    }
    return abort(init?.signal);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("API request timeout", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("aborts GET requests after 10 seconds and clears the timer", async () => {
    const fetchMock = mockFetchUntilAborted();
    const request = api.distinctFunctions();
    const rejection = expect(request).rejects.toThrow("Request timed out");

    await vi.advanceTimersByTimeAsync(10_000);

    await rejection;
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("aborts POST requests after 10 seconds and clears the timer", async () => {
    const fetchMock = mockFetchUntilAborted();
    const meta: ContractMeta = {
      id: "contract",
      name: "Contract",
      description: "",
      functions: [],
    };
    const request = api.registerContract(meta);
    const rejection = expect(request).rejects.toThrow("Request timed out");

    await vi.advanceTimersByTimeAsync(10_000);

    await rejection;
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][1]?.method).toBe("POST");
    expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps the timeout active while parsing the response body", async () => {
    const fetchMock = mockFetchUntilAborted(true);
    const request = api.distinctFunctions();
    const rejection = expect(request).rejects.toThrow("Request timed out");

    await vi.advanceTimersByTimeAsync(10_000);

    await rejection;
    expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
