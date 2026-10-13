/** Errors whose message is safe and useful to show to the end user / agent. */
export class UserInputError extends Error {
  override name = 'UserInputError';
}

export class AuthError extends Error {
  override name = 'AuthError';
}

export class RateLimitError extends Error {
  override name = 'RateLimitError';
  constructor(message: string, public readonly retryAfterSecs: number) {
    super(message);
  }
}

export class ApifyError extends Error {
  override name = 'ApifyError';
  constructor(message: string, public readonly status?: number, public readonly retryable = false) {
    super(message);
  }
}

export class CancelledError extends Error {
  override name = 'CancelledError';
}

const SAFE = [UserInputError, AuthError, RateLimitError, ApifyError, CancelledError];

/** Removes anything token-shaped from a string before it reaches logs or clients. */
export function redact(text: string): string {
  return text
    .replace(/apify_api_[A-Za-z0-9]+/g, 'apify_api_***')
    .replace(/([?&](?:token|apiKey|api_key)=)[^&\s]+/gi, '$1***')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1***');
}

export function toUserMessage(err: unknown): string {
  if (SAFE.some((cls) => err instanceof cls)) return redact((err as Error).message);
  return 'Internal error while running the audit. Please retry; if it persists, report it with the time of the call.';
}
