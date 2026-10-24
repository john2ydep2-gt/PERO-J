import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import BetSlip from "../components/BetSlip";

describe("BetSlip Component", () => {
  it("renders bet slip with current odds and defaults", () => {
    render(
      <BetSlip
        marketId={1}
        marketTitle="Will Soroban process 10M transactions?"
        currentOddsBps={7000}
      />
    );

    expect(screen.getByText("Will Soroban process 10M transactions?")).toBeTruthy();
    expect(screen.getByText("YES (70.00%)")).toBeTruthy();
    expect(screen.getByText("NO (30.00%)")).toBeTruthy();
    expect(screen.getByText("1.0%")).toBeTruthy();
  });

  it("updates slippage when preset buttons are clicked", () => {
    render(
      <BetSlip
        marketId={1}
        marketTitle="Test Market"
        currentOddsBps={5000}
      />
    );

    const button5 = screen.getByText("5%");
    fireEvent.click(button5);
    expect(screen.getByText("5.0%")).toBeTruthy();

    const button10 = screen.getByText("10%");
    fireEvent.click(button10);
    expect(screen.getByText("10.0%")).toBeTruthy();
  });

  it("submits bet with calculated minAcceptableOdds", () => {
    const handlePlaceBet = vi.fn();
    render(
      <BetSlip
        marketId={1}
        marketTitle="Test Market"
        currentOddsBps={7000}
        onPlaceBet={handlePlaceBet}
      />
    );

    // Select 5% slippage -> 7000 * 0.95 = 6650 bps
    fireEvent.click(screen.getByText("5%"));

    const submitBtn = screen.getByText("Place Protected Bet");
    fireEvent.click(submitBtn);

    expect(handlePlaceBet).toHaveBeenCalledTimes(1);
    expect(handlePlaceBet).toHaveBeenCalledWith({
      marketId: 1,
      isYes: true,
      amount: 10,
      minAcceptableOdds: 6650,
      slippageTolerance: 5,
    });
  });

  it("shows warning when high custom slippage is entered", () => {
    render(
      <BetSlip
        marketId={1}
        marketTitle="Test Market"
        currentOddsBps={5000}
      />
    );

    const customInput = screen.getByLabelText("Custom slippage percentage");
    fireEvent.change(customInput, { target: { value: "15" } });

    expect(screen.getByRole("alert")).toBeTruthy();
    expect(
      screen.getByText(/High slippage tolerance increases risk of sandwich attacks/i)
    ).toBeTruthy();
  });
});
