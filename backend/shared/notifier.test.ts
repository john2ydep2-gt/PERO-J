/**
 * Tests for backend/shared/notifier.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  NotifierBot,
  ChannelRateLimiter,
  SEVERITY_COLORS,
  AlertPayload,
} from "./notifier.js";

describe("NotifierBot & ChannelRateLimiter", () => {
  it("formats Discord rich embed correctly with severity colors", () => {
    const bot = new NotifierBot({
      webUiBaseUrl: "https://pero-j.io",
    });

    const alert: AlertPayload = {
      channel: "alerts-critical",
      severity: "critical",
      title: "Soroban RPC Latency Spike",
      description: "Response time exceeded 2.5 seconds.",
      fields: [{ name: "Latency", value: "3.1s", inline: true }],
      url: "/monitoring",
    };

    const discordPayload = bot.formatDiscordPayload(alert);
    assert.ok(discordPayload.embeds);
    assert.equal(discordPayload.embeds.length, 1);

    const embed = discordPayload.embeds[0];
    assert.equal(embed.title, "[CRITICAL] Soroban RPC Latency Spike");
    assert.equal(embed.color, SEVERITY_COLORS.critical.decimal);
    assert.equal(embed.url, "https://pero-j.io/monitoring");
    assert.equal(embed.fields?.[0]?.name, "Latency");
  });

  it("formats Slack Block Kit payload with colored attachment", () => {
    const bot = new NotifierBot({
      webUiBaseUrl: "https://pero-j.io",
    });

    const alert: AlertPayload = {
      channel: "oracle-disputes",
      severity: "warning",
      title: "Market Dispute Raised",
      description: "Market #42 contested by validator.",
      fields: [{ name: "Stake", value: "10,000 XLM", inline: true }],
      url: "/markets/42",
    };

    const slackPayload = bot.formatSlackPayload(alert);
    assert.ok(slackPayload.attachments);
    assert.equal(slackPayload.attachments[0].color, SEVERITY_COLORS.warning.hex);
    assert.ok(slackPayload.attachments[0].blocks.length >= 2);
  });

  it("enforces rate limiting per channel during alert storms", () => {
    const limiter = new ChannelRateLimiter(3);
    const now = Date.now();

    assert.equal(limiter.isRateLimited("alerts-critical", now), false);
    assert.equal(limiter.isRateLimited("alerts-critical", now + 100), false);
    assert.equal(limiter.isRateLimited("alerts-critical", now + 200), false);

    // 4th alert in the same minute window should be rate limited
    assert.equal(limiter.isRateLimited("alerts-critical", now + 300), true);

    // Different channel should still be permitted
    assert.equal(limiter.isRateLimited("oracle-disputes", now + 300), false);

    // After 61 seconds, window slides and alerts are permitted again
    assert.equal(limiter.isRateLimited("alerts-critical", now + 61_000), false);
  });
});
