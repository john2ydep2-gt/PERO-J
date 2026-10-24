CREATE TABLE IF NOT EXISTS checkpoint_state (
  service_name VARCHAR PRIMARY KEY,
  last_ledger_sequence BIGINT NOT NULL,
  last_ledger_hash VARCHAR(64) NOT NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);