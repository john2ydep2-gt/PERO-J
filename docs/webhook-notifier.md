# Discord & Slack Alert Webhook Notification Bot

## 1. Overview

The PERO-J alert webhook notification bot (`backend/shared/notifier.ts`) automatically dispatches real-time, actionable alerts to internal engineering and operations chat channels across Discord and Slack.

## 2. Channel Architecture & Routing

Alerts are partitioned across dedicated channels to prevent alert fatigue and route issues to appropriate teams:

| Channel | Focus | Trigger Events | Severity |
| :--- | :--- | :--- | :--- |
| **`#alerts-critical`** | Critical system health | Frontend outage, Soroban RPC latency > 2.5s, Indexer crash | Critical (Red: `#EF4444`) |
| **`#oracle-disputes`** | Market operations | Oracle outcome contestation, disputed resolution, quorum delay | Warning (Amber: `#F59E0B`) |
| **`#audit-events`** | Governance & security | Multi-sig upgrade proposal, admin key rotation, fee withdrawal | Info (Blue: `#3B82F6`) |

## 3. Configuration & Environment Variables

Configure inbound webhook URLs in `.env`:

```env
# Discord Webhooks
DISCORD_WEBHOOK_CRITICAL=https://discord.com/api/webhooks/...
DISCORD_WEBHOOK_ORACLE_DISPUTES=https://discord.com/api/webhooks/...
DISCORD_WEBHOOK_AUDIT_EVENTS=https://discord.com/api/webhooks/...

# Slack Webhooks
SLACK_WEBHOOK_CRITICAL=https://hooks.slack.com/services/...
SLACK_WEBHOOK_ORACLE_DISPUTES=https://hooks.slack.com/services/...
SLACK_WEBHOOK_AUDIT_EVENTS=https://hooks.slack.com/services/...

# Web UI Link Base
WEB_UI_BASE_URL=https://app.pero-j.io

# Rate Limiting (Alerts per minute before suppression)
ALERT_RATE_LIMIT_PER_MINUTE=30
```

## 4. Message Formatting & Embeds

### Discord Rich Embeds
- **Severity Color Bar**: Red (`0xEF4444`), Amber (`0xF59E0B`), Blue (`0x3B82F6`).
- **Structured Fields**: Latency, Market ID, Ledger Seq, and Actor.
- **Direct Link**: Clickable link navigating straight to relevant Web UI dispute or monitoring page.
- **Timestamp**: ISO 8601 UTC timestamp.

### Slack Block Kit
- Formatted attachments with matching hex color bars.
- Header and section blocks.
- Action button ("View in Web UI") directing operators directly to the affected resource.

## 5. Rate Limiting Defense

To prevent flooding during alert storms (e.g., downstream network outage causing multiple consecutive health probe failures), the bot implements a sliding-window rate limiter:
- Window: 60 seconds.
- Default limit: 30 alerts per channel per minute.
- Excess alerts are suppressed and logged with a warning.
