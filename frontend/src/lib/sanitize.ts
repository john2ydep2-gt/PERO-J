/**
 * Frontend sanitization and length limit validation for market question and description fields.
 * Prevents stored XSS attacks and ensures data conforms to smart contract bounds.
 */

export const MAX_TITLE_LEN = 160;
export const MAX_DESCRIPTION_LEN = 1000;
export const MAX_URL_LEN = 256;

/**
 * Strip all HTML tags, script elements, and dangerous protocols from user-supplied strings.
 * Acts as a lightweight, zero-dependency sanitizer for frontend input and display rendering.
 */
export function stripHtml(input: string): string {
  if (typeof input !== "string") return "";
  return input
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, "")
    .replace(/<[^>]+>/g, "")
    .replace(/javascript:/gi, "")
    .replace(/data:/gi, "");
}

/**
 * Sanitize text input: strips HTML tags, escapes dangerous characters, and trims whitespace.
 */
export function sanitizeInput(input: string): string {
  return stripHtml(input).trim();
}

/**
 * Validate that an external evidence URL is safe and well-formed.
 * Only HTTP and HTTPS protocols are accepted. Rejects javascript: or data: payloads.
 */
export function isValidMarketUrl(rawUrl: string): boolean {
  if (typeof rawUrl !== "string") return false;
  const trimmed = rawUrl.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_URL_LEN) return false;

  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Validates market question/title field against contract limit (<= 160 chars).
 */
export function validateMarketQuestion(title: string): { valid: boolean; error?: string } {
  if (!title || typeof title !== "string" || title.trim().length === 0) {
    return { valid: false, error: "Question/title cannot be empty" };
  }
  const clean = sanitizeInput(title);
  if (clean.length === 0) {
    return { valid: false, error: "Question/title must contain valid text" };
  }
  if (clean.length > MAX_TITLE_LEN) {
    return { valid: false, error: `Question/title exceeds maximum limit of ${MAX_TITLE_LEN} characters` };
  }
  return { valid: true };
}

/**
 * Validates market description field against contract limit (<= 1000 chars).
 */
export function validateMarketDescription(description: string): { valid: boolean; error?: string } {
  if (typeof description !== "string") return { valid: true };
  const clean = sanitizeInput(description);
  if (clean.length > MAX_DESCRIPTION_LEN) {
    return { valid: false, error: `Description exceeds maximum limit of ${MAX_DESCRIPTION_LEN} characters` };
  }
  return { valid: true };
}
