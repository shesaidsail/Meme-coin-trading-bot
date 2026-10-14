export type ApiErrorKind = 'http' | 'timeout' | 'network' | 'rate_limited' | 'budget' | 'schema';

export class ApiError extends Error {
  override name = 'ApiError';
  constructor(
    readonly provider: string,
    readonly kind: ApiErrorKind,
    message: string,
    readonly status?: number,
    /** Parsed JSON body of an error response, when there was one. */
    readonly body?: unknown,
  ) {
    super(`${provider}: ${message}`);
  }
}

export class BudgetExhaustedError extends ApiError {
  override name = 'BudgetExhaustedError';
  constructor(provider: string, message: string) {
    super(provider, 'budget', message);
  }
}
