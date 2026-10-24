import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import NetworkStatusChip from "../components/NetworkStatusChip";

// Stub EventSource so tests don't make real network connections
class MockEventSource {
  static instances: MockEventSource[] = [];
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  addEventListener = vi.fn();
  close = vi.fn();
  constructor(public url: string) {
    MockEventSource.instances.push(this);
  }
}

beforeEach(() => {
  MockEventSource.instances = [];
  (globalThis as unknown as Record<string, unknown>).EventSource = MockEventSource;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("NetworkStatusChip", () => {
  it('shows "Live" when navigator.onLine is true and SSE is healthy', () => {
    Object.defineProperty(navigator, "onLine", { value: true, configurable: true });
    render(<NetworkStatusChip sseUrl="/api/events/stream" />);

    // Simulate SSE open event
    act(() => {
      const es = MockEventSource.instances[0];
      es.addEventListener.mock.calls
        .filter(([ev]: [string]) => ev === "open")
        .forEach(([, cb]: [string, () => void]) => cb());
    });

    expect(screen.getByRole("status")).toHaveAttribute(
      "aria-label",
      "Connection status: live"
    );
    expect(screen.getByText("Live")).toBeTruthy();
  });

  it('shows "Offline" when navigator.onLine is false', () => {
    Object.defineProperty(navigator, "onLine", { value: false, configurable: true });
    render(<NetworkStatusChip />);
    expect(screen.getByRole("status")).toHaveAttribute(
      "aria-label",
      "Connection status: offline"
    );
    expect(screen.getByText("Offline")).toBeTruthy();
  });

  it('shows "Reconnecting…" when online but SSE errors', () => {
    Object.defineProperty(navigator, "onLine", { value: true, configurable: true });
    render(<NetworkStatusChip sseUrl="/api/events/stream" />);

    act(() => {
      const es = MockEventSource.instances[0];
      es.onerror?.(new Event("error"));
    });

    expect(screen.getByRole("status")).toHaveAttribute(
      "aria-label",
      "Connection status: reconnecting"
    );
    expect(screen.getByText("Reconnecting…")).toBeTruthy();
  });
});
