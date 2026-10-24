/**
 * Input sanitization and length limit validation for market question and description fields.
 * Protects backend services and client consumers from stored XSS and rent-bloating payloads.
 */

export const MAX_TITLE_LEN = 160;
export const MAX_DESCRIPTION_LEN = 1000;
export const MAX_URL_LEN = 256;

/**
 * Strip all HTML tags, script elements, and dangerous characters from a string.
 *
 * @param {string} input
 * @returns {string} sanitized text
 */
export function stripHtml(input) {
  if (typeof input !== "string") return "";
  return input
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, "")
    .replace(/<[^>]+>/g, "")
    .replace(/javascript:/gi, "")
    .replace(/data:/gi, "");
}

/**
 * Sanitize text input: strip HTML tags and trim leading/trailing whitespace.
 *
 * @param {string} input
 * @returns {string}
 */
export function sanitizeText(input) {
  return stripHtml(input).trim();
}

/**
 * Validate that an external evidence URL is safe and well-formed.
 * Only HTTP and HTTPS protocols are permitted. Rejects javascript:, data:, and oversized URLs.
 *
 * @param {string} rawUrl
 * @returns {boolean}
 */
export function isValidUrl(rawUrl) {
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
 * Validate and sanitize market creation/update fields.
 *
 * @param {{ title?: string, description?: string, source_url?: string }} payload
 * @returns {{ valid: boolean, error?: string, sanitized?: { title: string, description: string, source_url: string | null } }}
 */
export function validateMarketInput(payload) {
  if (!payload || typeof payload !== "object") {
    return { valid: false, error: "Market payload must be a JSON object" };
  }

  const { title, description, source_url } = payload;

  if (typeof title !== "string" || title.trim().length === 0) {
    return { valid: false, error: "Title is required and must not be empty" };
  }

  const sanitizedTitle = sanitizeText(title);
  if (sanitizedTitle.length === 0) {
    return { valid: false, error: "Title must contain non-HTML printable characters" };
  }
  if (sanitizedTitle.length > MAX_TITLE_LEN) {
    return { valid: false, error: `Title exceeds maximum limit of ${MAX_TITLE_LEN} characters` };
  }

  const rawDesc = typeof description === "string" ? description : "";
  const sanitizedDesc = sanitizeText(rawDesc);
  if (sanitizedDesc.length > MAX_DESCRIPTION_LEN) {
    return { valid: false, error: `Description exceeds maximum limit of ${MAX_DESCRIPTION_LEN} characters` };
  }

  let sanitizedUrl = null;
  if (source_url !== undefined && source_url !== null && source_url !== "") {
    if (typeof source_url !== "string" || !isValidUrl(source_url)) {
      return { valid: false, error: "source_url must be a valid http or https URL (max 256 characters)" };
    }
    sanitizedUrl = source_url.trim();
  }

  return {
    valid: true,
    sanitized: {
      title: sanitizedTitle,
      description: sanitizedDesc,
      source_url: sanitizedUrl,
    },
  };
}
