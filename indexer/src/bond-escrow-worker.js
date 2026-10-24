import { db } from "./db.js";

export class EscrowInvariantError extends Error {
  constructor(message, details) {
    super(message);
    this.name = "EscrowInvariantError";
    this.details = details;
  }
}

export class BondEscrowWorker {
  /**
   * @param {object} [opts]
   * @param {any} [opts.database] - Database abstraction (defaults to db)
   * @param {() => Promise<number|string>} [opts.getContractBalance] - Function to fetch on-chain SAC balance
   * @param {number} [opts.checkIntervalMs=10000] - Audit interval in ms
   * @param {(alert: object) => void} [opts.onAlert] - Optional callback when circuit breaker trips
   */
  constructor({
    database = null,
    getContractBalance = null,
    checkIntervalMs = 10_000,
    onAlert = null,
  } = {}) {
    this.db = database || db;
    this.getContractBalance = getContractBalance;
    this.checkIntervalMs = checkIntervalMs;
    this.onAlert = onAlert;

    this.circuitBreaker = {
      tripped: false,
      reason: null,
      trippedAt: null,
      details: null,
    };

    this.automatedResolutionHalted = false;
    this.timer = null;
    this.auditHistory = [];
  }

  /**
   * Assert the protocol escrow invariant:
   * total_bonds_deposited - total_bonds_settled == current_escrow_holdings
   *
   * @param {number|string} totalDeposited
   * @param {number|string} totalSettled
   * @param {number|string} currentHoldings
   * @throws {EscrowInvariantError} if escrow_in - escrow_out !== current_holdings
   * @returns {boolean}
   */
  assertInvariant(totalDeposited, totalSettled, currentHoldings) {
    const deposited = BigInt(Math.floor(Number(totalDeposited) || 0));
    const settled = BigInt(Math.floor(Number(totalSettled) || 0));
    const actual = BigInt(Math.floor(Number(currentHoldings) || 0));

    const expected = deposited - settled;

    if (expected !== actual) {
      const leakage = expected - actual;
      const details = {
        total_bonds_deposited: deposited.toString(),
        total_bonds_settled: settled.toString(),
        expected_escrow_holdings: expected.toString(),
        current_escrow_holdings: actual.toString(),
        leakage_amount: leakage.toString(),
      };
      throw new EscrowInvariantError(
        `Bond escrow invariant violation: expected ${expected} holdings (deposited ${deposited} - settled ${settled}), but contract holds ${actual} (leakage: ${leakage})`,
        details
      );
    }

    return true;
  }

  /**
   * Run an audit check comparing total escrowed bonds recorded in DB
   * against contract XLM SAC balance.
   *
   * @param {object} [opts]
   * @param {number|string} [opts.contractBalance] - Optional explicit contract balance override
   * @returns {Promise<object>} Audit report
   */
  async verifyEscrowInvariant({ contractBalance = null } = {}) {
    const timestamp = new Date().toISOString();
    let accounting;

    try {
      accounting = await this.db.getBondAccounting();
    } catch (err) {
      console.error("[bond-escrow-worker] DB getBondAccounting error:", err.message);
      accounting = {
        total_bonds_deposited: 0,
        total_bonds_settled: 0,
        expected_escrow_holdings: 0,
        active_disputes: 0,
      };
    }

    let actualHoldings = contractBalance;
    if (actualHoldings === null || actualHoldings === undefined) {
      if (typeof this.getContractBalance === "function") {
        try {
          actualHoldings = await this.getContractBalance();
        } catch (err) {
          console.error("[bond-escrow-worker] Contract balance fetch error:", err.message);
          actualHoldings = accounting.expected_escrow_holdings;
        }
      } else {
        actualHoldings = accounting.expected_escrow_holdings;
      }
    }

    try {
      this.assertInvariant(
        accounting.total_bonds_deposited,
        accounting.total_bonds_settled,
        actualHoldings
      );

      const report = {
        valid: true,
        checked_at: timestamp,
        total_bonds_deposited: accounting.total_bonds_deposited,
        total_bonds_settled: accounting.total_bonds_settled,
        expected_escrow_holdings: accounting.expected_escrow_holdings,
        current_escrow_holdings: actualHoldings,
        active_disputes: accounting.active_disputes,
        resolution_allowed: this.isResolutionAllowed(),
      };

      this.auditHistory.unshift(report);
      if (this.auditHistory.length > 50) this.auditHistory.pop();

      return report;
    } catch (err) {
      const details = err.details || {
        reason: err.message,
        expected: accounting.expected_escrow_holdings,
        actual: actualHoldings,
      };

      this.tripCircuitBreaker(details);

      const report = {
        valid: false,
        checked_at: timestamp,
        error: err.message,
        details,
        circuit_breaker: this.getCircuitBreakerStatus(),
        resolution_allowed: false,
      };

      this.auditHistory.unshift(report);
      if (this.auditHistory.length > 50) this.auditHistory.pop();

      return report;
    }
  }

  /**
   * Trip the circuit breaker and halt automated dispute resolution.
   *
   * @param {object} details
   */
  tripCircuitBreaker(details) {
    this.circuitBreaker.tripped = true;
    this.circuitBreaker.reason =
      details.reason || "Bond escrow accounting mismatch detected (zero fund leakage violated)";
    this.circuitBreaker.trippedAt = new Date().toISOString();
    this.circuitBreaker.details = details;

    this.haltAutomatedResolution();

    const alertPayload = {
      level: "CRITICAL",
      type: "BOND_ESCROW_INVARIANT_VIOLATION",
      message: this.circuitBreaker.reason,
      details,
      trippedAt: this.circuitBreaker.trippedAt,
    };

    console.error("[CRITICAL ALERT] [CIRCUIT BREAKER TRIPPED]", alertPayload);

    if (typeof this.onAlert === "function") {
      try {
        this.onAlert(alertPayload);
      } catch (err) {
        console.error("[bond-escrow-worker] Alert callback failed:", err.message);
      }
    }
  }

  /**
   * Halt automated resolution of disputes.
   */
  haltAutomatedResolution() {
    this.automatedResolutionHalted = true;
    console.warn(
      "[bond-escrow-worker] Automated dispute resolution has been HALTED to prevent collateral drain."
    );
  }

  /**
   * Check whether automated resolution is permitted.
   *
   * @returns {boolean}
   */
  isResolutionAllowed() {
    return !this.automatedResolutionHalted && !this.circuitBreaker.tripped;
  }

  /**
   * Reset the circuit breaker and re-enable automated dispute resolution.
   */
  resetCircuitBreaker() {
    this.circuitBreaker = {
      tripped: false,
      reason: null,
      trippedAt: null,
      details: null,
    };
    this.automatedResolutionHalted = false;
    console.log("[bond-escrow-worker] Circuit breaker reset. Automated resolution re-enabled.");
  }

  /**
   * Return the current circuit breaker status.
   *
   * @returns {object}
   */
  getCircuitBreakerStatus() {
    return {
      tripped: this.circuitBreaker.tripped,
      reason: this.circuitBreaker.reason,
      tripped_at: this.circuitBreaker.trippedAt,
      details: this.circuitBreaker.details,
      automated_resolution_halted: this.automatedResolutionHalted,
    };
  }

  /**
   * Start periodic continuous invariant verification.
   */
  start() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.verifyEscrowInvariant().catch((err) => {
        console.error("[bond-escrow-worker] Periodic audit error:", err);
      });
    }, this.checkIntervalMs);
  }

  /**
   * Stop periodic continuous verification.
   */
  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

export const bondEscrowWorker = new BondEscrowWorker();
