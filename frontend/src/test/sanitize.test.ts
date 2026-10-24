import { describe, it, expect } from "vitest";
import {
  stripHtml,
  sanitizeInput,
  isValidMarketUrl,
  validateMarketQuestion,
  validateMarketDescription,
  MAX_TITLE_LEN,
  MAX_DESCRIPTION_LEN,
} from "../lib/sanitize";

describe("Input Sanitization and Length Limits", () => {
  describe("stripHtml", () => {
    it("strips script tags and executable JS payload", () => {
      const malicious = '<script>alert("XSS")</script>Will BTC hit $100k?';
      expect(stripHtml(malicious)).toBe("Will BTC hit $100k?");
    });

    it("strips inline HTML tags (img onerror, etc.)", () => {
      const malicious = '<img src=x onerror=alert(1)>Prediction Market <b style="color:red">Question</b>';
      expect(stripHtml(malicious)).toBe("Prediction Market Question");
    });

    it("strips javascript: and data: schemes", () => {
      expect(stripHtml("javascript:alert(1)")).toBe("alert(1)");
      expect(stripHtml("data:text/html,<script>evil()</script>")).toBe("text/html,");
    });
  });

  describe("sanitizeInput", () => {
    it("trims whitespace and cleans tags", () => {
      expect(sanitizeInput("   <p>Hello World</p>   ")).toBe("Hello World");
    });
  });

  describe("isValidMarketUrl", () => {
    it("accepts valid https and http URLs", () => {
      expect(isValidMarketUrl("https://stellar.org/news/announcement")).toBe(true);
      expect(isValidMarketUrl("http://example.com/evidence")).toBe(true);
    });

    it("rejects javascript: and data: URLs", () => {
      expect(isValidMarketUrl("javascript:alert(1)")).toBe(false);
      expect(isValidMarketUrl("data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==")).toBe(false);
    });

    it("rejects empty, invalid, or oversized URLs", () => {
      expect(isValidMarketUrl("")).toBe(false);
      expect(isValidMarketUrl("not a url")).toBe(false);
      expect(isValidMarketUrl(`https://stellar.org/${"a".repeat(260)}`)).toBe(false);
    });
  });

  describe("validateMarketQuestion", () => {
    it("accepts valid title <= 160 characters", () => {
      const res = validateMarketQuestion("Will Soroban protocol 22 be deployed before Q4?");
      expect(res.valid).toBe(true);
      expect(res.error).toBeUndefined();
    });

    it("accepts title at exact 160 character boundary", () => {
      const exact160 = "a".repeat(MAX_TITLE_LEN);
      expect(validateMarketQuestion(exact160).valid).toBe(true);
    });

    it("rejects oversized title > 160 characters", () => {
      const oversized = "a".repeat(MAX_TITLE_LEN + 1);
      const res = validateMarketQuestion(oversized);
      expect(res.valid).toBe(false);
      expect(res.error).toContain("exceeds maximum limit");
    });

    it("rejects empty or whitespace title", () => {
      expect(validateMarketQuestion("").valid).toBe(false);
      expect(validateMarketQuestion("   ").valid).toBe(false);
      expect(validateMarketQuestion("<script></script>").valid).toBe(false);
    });
  });

  describe("validateMarketDescription", () => {
    it("accepts valid description <= 1000 characters", () => {
      const res = validateMarketDescription("Detailed resolution criteria according to official announcement.");
      expect(res.valid).toBe(true);
    });

    it("accepts description at exact 1000 character boundary", () => {
      const exact1000 = "b".repeat(MAX_DESCRIPTION_LEN);
      expect(validateMarketDescription(exact1000).valid).toBe(true);
    });

    it("rejects oversized description > 1000 characters", () => {
      const oversized = "b".repeat(MAX_DESCRIPTION_LEN + 1);
      const res = validateMarketDescription(oversized);
      expect(res.valid).toBe(false);
      expect(res.error).toContain("exceeds maximum limit");
    });
  });
});
