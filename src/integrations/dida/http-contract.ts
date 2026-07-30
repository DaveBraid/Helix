import type { SyncErrorCategory, SyncFailure } from "../../sync/types";

export interface HttpRequest {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
}

export interface HttpResponse<T = unknown> {
  status: number;
  headers: Record<string, string>;
  data: T;
  text: string;
}

export interface HttpTransport {
  request<T>(request: HttpRequest): Promise<HttpResponse<T>>;
}

export class DidaHttpError extends Error implements SyncFailure {
  constructor(
    public readonly category: SyncErrorCategory,
    message: string,
    public readonly statusCode?: number,
    public readonly retryAfterMs?: number,
    public readonly remoteOutcomeUnknown?: boolean,
  ) {
    super(message);
    this.name = "DidaHttpError";
  }
}

export function classifyStatus(
  status: number,
  message: string,
  headers: Record<string, string> = {},
): DidaHttpError {
  if (status === 401) return new DidaHttpError("authentication", message, status);
  if (status === 403) return new DidaHttpError("authorization", message, status);
  if (status === 429) {
    const retryAfter = Number(headers["retry-after"] ?? headers["Retry-After"]);
    return new DidaHttpError(
      "rate-limit",
      message,
      status,
      Number.isFinite(retryAfter) ? retryAfter * 1_000 : 30_000,
    );
  }
  if (status >= 500) return new DidaHttpError("transient", message, status);
  if (status >= 400) return new DidaHttpError("permanent", message, status);
  return new DidaHttpError("invalid-response", message, status);
}
