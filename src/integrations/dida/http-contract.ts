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
  rawResponseBody?: string,
): DidaHttpError {
  // Dida 会以 500 携带明确的查询配额错误；这是可恢复的读限流，而非写入成功与否。
  if (status === 500 && hasExplicitQueryLimitCode(rawResponseBody)) {
    return new DidaHttpError(
      "rate-limit",
      "查询限流，稍后只读复核",
      status,
      positiveRetryAfterMs(headers, 60_000),
    );
  }
  if (status === 401) return new DidaHttpError("authentication", message, status);
  if (status === 403) return new DidaHttpError("authorization", message, status);
  if (status === 429) {
    return new DidaHttpError(
      "rate-limit",
      message,
      status,
      positiveRetryAfterMs(headers, 30_000),
    );
  }
  if (status >= 500) return new DidaHttpError("transient", message, status);
  if (status >= 400) return new DidaHttpError("permanent", message, status);
  return new DidaHttpError("invalid-response", message, status);
}

/** 只用于分类，不把原始响应正文保存或带入错误消息。 */
function hasExplicitQueryLimitCode(body: string | undefined): boolean {
  if (!body) return false;
  return /["']errorCode["']\s*:\s*["']exceed_query_limit["']/i.test(body) ||
    /\berrorCode\s*=\s*exceed_query_limit\b/i.test(body);
}

function positiveRetryAfterMs(headers: Record<string, string>, fallback: number): number {
  const seconds = Number(headers["retry-after"] ?? headers["Retry-After"]);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1_000 : fallback;
}
