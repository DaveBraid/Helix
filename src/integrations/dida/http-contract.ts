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
    public readonly limitKind?: "retry-after" | "query-limit",
    public readonly requestNotSent?: boolean,
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
  now = Date.now(),
): DidaHttpError {
  // Dida 会以 500 携带明确的查询配额错误；这是可恢复的读限流，而非写入成功与否。
  if (status === 500 && hasExplicitQueryLimitCode(rawResponseBody)) {
    return new DidaHttpError(
      "rate-limit",
      "查询限流，稍后只读复核",
      status,
      positiveRetryAfterMs(headers, 15 * 60_000, now),
      undefined,
      "query-limit",
    );
  }
  if (status === 401) return new DidaHttpError("authentication", message, status);
  if (status === 403) return new DidaHttpError("authorization", message, status);
  if (status === 429) {
    return new DidaHttpError(
      "rate-limit",
      message,
      status,
      positiveRetryAfterMs(headers, 30_000, now),
      undefined,
      "retry-after",
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

function positiveRetryAfterMs(
  headers: Record<string, string>,
  fallback: number,
  now: number,
): number {
  const raw = Object.entries(headers).find(([key]) => key.toLowerCase() === "retry-after")?.[1]?.trim();
  if (!raw) return fallback;
  let duration: number;
  if (/^\d+(?:\.\d+)?$/u.test(raw)) {
    const seconds = Number(raw);
    if (!Number.isFinite(seconds)) return 24 * 60 * 60_000;
    duration = seconds * 1_000;
  } else {
    const at = Date.parse(raw);
    if (!Number.isFinite(at)) return fallback;
    duration = at - now;
  }
  if (!Number.isFinite(duration)) return 24 * 60 * 60_000;
  if (duration <= 0) return fallback;
  const maxRepresentable = 8_640_000_000_000_000 - now;
  return Math.min(maxRepresentable, Math.max(1_000, Math.ceil(duration)));
}
