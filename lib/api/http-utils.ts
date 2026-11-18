/**
 * HTTP Utilities for API calls
 * Handles timeouts and retries
 *
 * Performance / stability notes (2026-11-19, source-stability work):
 * - Per-attempt timeout is 8s: a source that does not answer in 8s is
 *   effectively dead for an interactive search on mobile.
 * - Retries are limited to 2 (3 attempts total) and only for retryable
 *   failures (network error, timeout, HTTP 5xx, 429). A 4xx response
 *   (e.g. 404 / 403 for a dead source) is not retried: retrying it
 *   three more times only wastes time and battery.
 * - Worst case per source is now ~3 x 8s + ~0.9s backoff ~= 25s,
 *   down from 4 x 15s = 60s. The parallel-search route adds a
 *   separate global deadline on top of this.
 */

// Disable SSL verification for video sources with invalid certificates
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const REQUEST_TIMEOUT = 8000;
const MAX_RETRIES = 2;
const RETRY_DELAY = 300;

/** True only for failures worth retrying. */
function isRetryableError(error: unknown): boolean {
    if (error instanceof Error) {
        if (error.name === 'AbortError') return true;
        // fetchWithTimeout / search callers throw `HTTP <status>: ...`
        const match = /HTTP (\d{3})/.exec(error.message);
        if (match) {
            const status = Number(match[1]);
            return status === 429 || status >= 500;
        }
        // Network-level failures (TypeError from fetch, ECONNRESET, etc.)
        return true;
    }
    return false;
}

/**
 * Fetch with timeout support
 */
export async function fetchWithTimeout(
    url: string,
    options: RequestInit = {},
    timeout: number = REQUEST_TIMEOUT
): Promise<Response> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
        const response = await fetch(url, {
            ...options,
            signal: controller.signal,
        });
        clearTimeout(timeoutId);
        return response;
    } catch (error) {
        clearTimeout(timeoutId);
        throw error;
    }
}

/**
 * Retry logic wrapper
 */
export async function withRetry<T>(
    fn: () => Promise<T>,
    retries: number = MAX_RETRIES
): Promise<T> {
    let lastError: Error | null = null;

    for (let i = 0; i <= retries; i++) {
        try {
            return await fn();
        } catch (error) {
            lastError = error as Error;

            // Do not retry non-retryable failures (e.g. HTTP 404/403):
            // the source is dead, not slow.
            if (!isRetryableError(error)) throw lastError;

            if (i < retries) {
                await new Promise(resolve => setTimeout(resolve, RETRY_DELAY * (i + 1)));
            }
        }
    }

    throw lastError;
}
