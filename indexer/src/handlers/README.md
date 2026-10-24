# Event Handlers

This directory contains specialized handlers for processing specific Soroban contract events that require database state updates beyond basic event logging.

## Overview

The indexer automatically invokes these handlers when processing events with matching function names:

- **claim** → `handleClaim()` - Records payout claims and updates user balances
- **fee_withdrawn** → `handleFeeWithdrawn()` - Records fee withdrawals and deducts from balances
- **reward_points** → `handleRewardPoints()` - Records loyalty reward points

## Handler Architecture

Each handler:
1. Receives a decoded event from the main indexer loop
2. Validates event structure and extracts relevant data
3. Performs database operations (inserts records, updates balances)
4. Logs the operation for monitoring

Handlers are fault-tolerant - errors are logged but don't stop the indexer from processing subsequent events.

## Database Schema

Handlers interact with these tables (created by migration #7):

### `user_balances`
Tracks user balances per contract
- `address` (TEXT) - User's Stellar address
- `contract_id` (TEXT) - Contract address
- `balance` (NUMERIC) - Current balance
- `updated_at` (TIMESTAMPTZ) - Last update timestamp

### `claims`
Records payout claim events
- `id` (BIGSERIAL) - Unique claim ID
- `address` (TEXT) - User's address
- `contract_id` (TEXT) - Contract address
- `market_id` (TEXT) - Optional market identifier
- `amount` (NUMERIC) - Claimed amount
- `status` (TEXT) - Claim status (e.g., 'completed', 'pending')
- `event_seq` (BIGINT) - Associated event sequence
- `ledger` (BIGINT) - Ledger number
- `tx_hash` (TEXT) - Transaction hash

### `fees`
Records fee withdrawal events
- `id` (BIGSERIAL) - Unique fee ID
- `address` (TEXT) - User's address
- `contract_id` (TEXT) - Contract address
- `fee_type` (TEXT) - Fee category (e.g., 'protocol', 'withdraw', 'trade')
- `amount` (NUMERIC) - Fee amount
- `event_seq` (BIGINT) - Associated event sequence
- `ledger` (BIGINT) - Ledger number
- `tx_hash` (TEXT) - Transaction hash

### `rewards`
Records loyalty reward point events
- `id` (BIGSERIAL) - Unique reward ID
- `address` (TEXT) - User's address
- `contract_id` (TEXT) - Contract address
- `points` (NUMERIC) - Reward points earned
- `reason` (TEXT) - Optional reason (e.g., 'trade', 'stake', 'referral')
- `event_seq` (BIGINT) - Associated event sequence
- `ledger` (BIGINT) - Ledger number
- `tx_hash` (TEXT) - Transaction hash

## Event Structure

Handlers expect decoded events with this structure:

```javascript
{
  contract_id: "CAAAA...",      // Contract address (strkey)
  function: "claim",             // Event function name
  raw_topics: [                  // Decoded event topics
    "claim",                     //   [0] function name
    "GAAAA...",                  //   [1] user address
    "market_001"                 //   [2] optional context (market_id, fee_type, reason)
  ],
  raw_data: '{"amount":"1000"}', // Stringified JSON event data
  ledger: 12345,                 // Ledger sequence number
  tx_hash: "abc...",             // Transaction hash
  seq: 1                         // Event database sequence (optional)
}
```

## Adding New Handlers

To add a new event handler:

1. Create a new file: `indexer/src/handlers/yourEvent.js`
2. Export a handler function: `export async function handleYourEvent(decodedEvent) { ... }`
3. Add the export to `indexer/src/handlers/index.js`
4. Wire it into the indexer in `indexer/src/index.js`:
   ```javascript
   switch (decoded.function) {
     case "your_event":
       await handleYourEvent(decoded);
       break;
   }
   ```
5. Optionally add a human-readable description in `indexer/src/decoder.js`

## Testing

Run the integration tests to verify handler behavior:

```bash
cd indexer
node src/handlers/handlers.test.js
```

The test suite verifies:
- Claims update user balances and record claim status
- Fee withdrawals deduct from balances and prevent negative balances
- Reward points accumulate correctly

## Monitoring

Handlers log their operations to stdout:
- Successful operations: `[handleClaim] Processed claim #123 for GAAAA...: 1000 on CAAAA...`
- Errors: `[handleClaim] Error processing claim event: <error message>`

Monitor these logs to track handler execution and troubleshoot issues.

## Error Handling

Handlers include multiple layers of error handling:

1. **Validation**: Check for required fields before processing
2. **Parsing**: Safely parse JSON data with try/catch
3. **Database**: Catch and log database errors
4. **Isolation**: Errors don't stop the indexer from processing other events

If a handler fails, the event is still persisted to the `events` table, but the specialized state updates (balances, claims, etc.) are not applied.
