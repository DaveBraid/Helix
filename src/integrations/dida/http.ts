import { requestUrl } from "obsidian";
import type {
  HttpRequest,
  HttpResponse,
  HttpTransport,
} from "./http-contract";
export * from "./http-contract";

export class ObsidianHttpTransport implements HttpTransport {
  async request<T>(request: HttpRequest): Promise<HttpResponse<T>> {
    const timeoutMs = request.timeoutMs ?? 20_000;
    let timeoutId: ReturnType<typeof globalThis.setTimeout> | undefined;
    const response = await Promise.race([
      requestUrl({
        url: request.url,
        method: request.method ?? "GET",
        headers: request.headers,
        body: request.body,
        throw: false,
      }),
      new Promise<never>((_resolve, reject) => {
        timeoutId = globalThis.setTimeout(
          () => reject(new Error(`Dida API 请求超过 ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]).finally(() => {
      if (timeoutId !== undefined) globalThis.clearTimeout(timeoutId);
    });
    return {
      status: response.status,
      headers: response.headers,
      data: response.json as T,
      text: response.text,
    };
  }
}
