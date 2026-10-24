/**
 * Reusable Data Provider HTTP Client
 *
 * Consolidates HTTP request boilerplate, token bucket rate-limiting,
 * exponential backoff retries with jitter, and standard error classification
 * across all external and internal data providers.
 */

// ============================================================================
// Standard Error Hierarchy
// ============================================================================

export class DataProviderError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'DataProviderError';
    this.providerName = options.providerName || 'DataProvider';
    this.statusCode = options.statusCode;
    this.endpoint = options.endpoint || '';
    this.isRetryable = options.isRetryable ?? false;
    this.responseBody = options.responseBody;
    if (options.cause) {
      this.cause = options.cause;
    }
  }
}

export class RateLimitExceededError extends DataProviderError {
  constructor(providerName, endpoint, retryAfterSeconds) {
    super(`Rate limit exceeded for provider "${providerName}" at ${endpoint}`, {
      providerName,
      statusCode: 429,
      endpoint,
      isRetryable: true,
    });
    this.name = 'RateLimitExceededError';
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export class TimeoutError extends DataProviderError {
  constructor(providerName, endpoint, timeoutMs) {
    super(`Request to "${providerName}" timed out after ${timeoutMs}ms at ${endpoint}`, {
      providerName,
      statusCode: 408,
      endpoint,
      isRetryable: true,
    });
    this.name = 'TimeoutError';
  }
}

export class AuthenticationError extends DataProviderError {
  constructor(providerName, endpoint, statusCode = 401) {
    super(`Authentication failed for provider "${providerName}" at ${endpoint}`, {
      providerName,
      statusCode,
      endpoint,
      isRetryable: false,
    });
    this.name = 'AuthenticationError';
  }
}

// ============================================================================
// Token Bucket Rate Limiter
// ============================================================================

export class TokenBucket {
  constructor(config = {}) {
    this.capacity = config.capacity || 20;
    this.refillRatePerSec = config.refillRatePerSec || 5;
    this.tokens = this.capacity;
    this.lastRefill = Date.now();
    this.blockedUntil = 0;
  }

  refill() {
    const now = Date.now();
    const elapsedSec = (now - this.lastRefill) / 1000;
    if (elapsedSec > 0) {
      this.tokens = Math.min(this.capacity, this.tokens + elapsedSec * this.refillRatePerSec);
      this.lastRefill = now;
    }
  }

  tryConsume(count = 1) {
    if (Date.now() < this.blockedUntil) return false;
    this.refill();
    if (this.tokens >= count) {
      this.tokens -= count;
      return true;
    }
    return false;
  }

  msUntilAvailable(count = 1) {
    const now = Date.now();
    if (now < this.blockedUntil) return this.blockedUntil - now;
    this.refill();
    if (this.tokens >= count) return 0;
    return Math.ceil(((count - this.tokens) / this.refillRatePerSec) * 1000);
  }

  async acquire(count = 1) {
    for (;;) {
      if (this.tryConsume(count)) return;
      const wait = Math.max(this.msUntilAvailable(count), 5);
      await new Promise((res) => setTimeout(res, wait));
    }
  }

  blockFor(seconds) {
    if (seconds > 0) {
      this.blockedUntil = Math.max(this.blockedUntil, Date.now() + seconds * 1000);
    }
  }
}

// ============================================================================
// Base Data Provider Client
// ============================================================================

export class BaseDataProviderClient {
  constructor(config = {}) {
    this.baseUrl = (config.baseUrl || '').replace(/\/+$/, '');
    this.providerName = config.providerName || 'DataProvider';
    this.apiKey = config.apiKey;
    this.timeoutMs = config.timeoutMs || 10000;
    this.defaultHeaders = {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      ...(config.headers || {}),
    };

    this.rateLimiter = config.rateLimit ? new TokenBucket(config.rateLimit) : null;
    this.retryConfig = {
      maxRetries: config.retry?.maxRetries ?? 3,
      initialBackoffMs: config.retry?.initialBackoffMs ?? 300,
      maxBackoffMs: config.retry?.maxBackoffMs ?? 5000,
      backoffMultiplier: config.retry?.backoffMultiplier ?? 2,
    };
  }

  async getHeaders() {
    const headers = { ...this.defaultHeaders };
    if (this.apiKey) {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }
    return headers;
  }

  async request(method, endpoint, body = undefined, options = {}) {
    const cleanEndpoint = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
    let url = `${this.baseUrl}${cleanEndpoint}`;

    if (options.params) {
      const searchParams = new URLSearchParams();
      for (const [key, val] of Object.entries(options.params)) {
        if (val !== undefined) searchParams.append(key, String(val));
      }
      const qs = searchParams.toString();
      if (qs) url += (url.includes('?') ? '&' : '?') + qs;
    }

    let attempt = 0;
    let lastError = null;

    while (attempt <= this.retryConfig.maxRetries) {
      if (this.rateLimiter) {
        await this.rateLimiter.acquire(1);
      }

      const timeoutMs = options.timeoutMs || this.timeoutMs;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const customHeaders = await this.getHeaders();
        const headers = { ...customHeaders, ...(options.headers || {}) };

        const fetchOptions = {
          method,
          headers,
          signal: controller.signal,
        };

        if (body !== undefined && method !== 'GET') {
          fetchOptions.body = typeof body === 'string' ? body : JSON.stringify(body);
        }

        const response = await fetch(url, fetchOptions);
        clearTimeout(timer);

        const retryAfterHeader = response.headers.get('Retry-After');
        if (retryAfterHeader && this.rateLimiter) {
          const secs = parseInt(retryAfterHeader, 10);
          if (!isNaN(secs) && secs > 0) {
            this.rateLimiter.blockFor(secs);
          }
        }

        if (response.ok) {
          if (response.status === 204) return null;
          const ct = response.headers.get('content-type') || '';
          if (ct.includes('application/json')) {
            return await response.json();
          }
          return await response.text();
        }

        let responseBody = null;
        try {
          responseBody = await response.json();
        } catch {
          try { responseBody = await response.text(); } catch {}
        }

        if (response.status === 401 || response.status === 403) {
          throw new AuthenticationError(this.providerName, cleanEndpoint, response.status);
        }

        if (response.status === 429) {
          const secs = retryAfterHeader ? parseInt(retryAfterHeader, 10) : undefined;
          throw new RateLimitExceededError(this.providerName, cleanEndpoint, secs);
        }

        const isServerErr = response.status >= 500 && response.status <= 504;
        const err = new DataProviderError(
          `Provider "${this.providerName}" responded with ${response.status}: ${response.statusText}`,
          {
            providerName: this.providerName,
            statusCode: response.status,
            endpoint: cleanEndpoint,
            isRetryable: isServerErr,
            responseBody,
          }
        );

        if (!isServerErr) throw err;
        lastError = err;
      } catch (err) {
        clearTimeout(timer);

        if (err.name === 'AbortError') {
          lastError = new TimeoutError(this.providerName, cleanEndpoint, timeoutMs);
        } else if (err instanceof DataProviderError) {
          if (!err.isRetryable) throw err;
          lastError = err;
        } else {
          lastError = new DataProviderError(`Network failure for "${this.providerName}": ${err.message}`, {
            providerName: this.providerName,
            endpoint: cleanEndpoint,
            isRetryable: true,
            cause: err,
          });
        }

        if (attempt >= this.retryConfig.maxRetries) break;

        const backoff = Math.min(
          this.retryConfig.initialBackoffMs * Math.pow(this.retryConfig.backoffMultiplier, attempt),
          this.retryConfig.maxBackoffMs
        );
        const jitter = Math.random() * 0.25 * backoff;
        await new Promise((res) => setTimeout(res, backoff + jitter));
        attempt++;
      }
    }

    throw lastError || new DataProviderError(`Request to "${this.providerName}" failed`, {
      providerName: this.providerName,
      endpoint: cleanEndpoint,
    });
  }

  get(endpoint, params, options) {
    return this.request('GET', endpoint, undefined, { ...options, params });
  }

  post(endpoint, body, options) {
    return this.request('POST', endpoint, body, options);
  }

  put(endpoint, body, options) {
    return this.request('PUT', endpoint, body, options);
  }

  delete(endpoint, options) {
    return this.request('DELETE', endpoint, undefined, options);
  }
}
