// smithy HttpHandler over Obsidian's requestUrl — one HTTP path that works WITHOUT CORS
// restrictions on desktop (Electron) and mobile (Capacitor/WKWebView) alike. Inspired by
// the Apache-2.0 ObsHttpHandler pattern from remotely-save/obsidian-livesync, written
// fresh against @smithy/protocol-http types.

import {
  buildQueryString,
  HttpRequest,
  HttpResponse,
  type HttpHandlerOptions,
} from "@smithy/core/protocols";
import { requestUrl, type RequestUrlParam } from "obsidian";

type RequestFn = typeof requestUrl;

export class ObsHttpHandler {
  constructor(
    private requestFn: RequestFn = requestUrl,
    private timeoutMs = 90_000,
  ) {}

  async handle(
    request: HttpRequest,
    { abortSignal }: HttpHandlerOptions = {},
  ): Promise<{ response: HttpResponse }> {
    if (abortSignal?.aborted) {
      throw Object.assign(new Error("Request aborted"), { name: "AbortError" });
    }

    let url = `${request.protocol}//${request.hostname}${request.port ? `:${request.port}` : ""}${request.path}`;
    if (request.query) {
      const qs = buildQueryString(request.query);
      if (qs) url += `?${qs}`;
    }

    // requestUrl/the platform sets Host and Content-Length itself; forwarding them can
    // produce duplicates some S3 providers reject.
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(request.headers)) {
      const lk = k.toLowerCase();
      if (lk === "host" || lk === "content-length") continue;
      headers[lk] = v;
    }
    const contentType = headers["content-type"];
    const body = toArrayBuffer(request.body, request.method);

    const param: RequestUrlParam = {
      url,
      method: request.method,
      headers,
      body,
      contentType,
      throw: false,
    };

    const rsp = await this.withTimeout(this.requestFn(param), abortSignal);
    const respHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(rsp.headers)) respHeaders[k.toLowerCase()] = v;
    const buf = rsp.arrayBuffer;
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array(buf));
        c.close();
      },
    });
    return {
      response: new HttpResponse({ headers: respHeaders, statusCode: rsp.status, body: stream }),
    };
  }

  private async withTimeout<T>(
    p: Promise<T>,
    abortSignal?: HttpHandlerOptions["abortSignal"],
  ): Promise<T> {
    return await new Promise<T>((resolve, reject) => {
      let settled = false;
      const finish = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };
      const timer = setTimeout(
        () =>
          finish(() =>
            reject(Object.assign(new Error("request timed out"), { name: "TimeoutError" })),
          ),
        this.timeoutMs,
      );
      if (abortSignal) {
        // smithy's AbortSignal is a minimal { aborted, onabort } shape (not the DOM one),
        // so use onabort rather than addEventListener.
        if (abortSignal.aborted) {
          finish(() => reject(Object.assign(new Error("Request aborted"), { name: "AbortError" })));
          return;
        }
        abortSignal.onabort = () =>
          finish(() => reject(Object.assign(new Error("Request aborted"), { name: "AbortError" })));
      }
      p.then(
        (v) => finish(() => resolve(v)),
        (e) => finish(() => reject(e)),
      );
    });
  }

  destroy(): void {}
}

function toArrayBuffer(body: unknown, method: string): ArrayBuffer | undefined {
  if (method === "GET" || method === "HEAD" || body === undefined || body === null)
    return undefined;
  if (typeof body === "string") return new TextEncoder().encode(body).buffer as ArrayBuffer;
  if (body instanceof ArrayBuffer) return body;
  if (ArrayBuffer.isView(body)) {
    return body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer;
  }
  throw new Error(
    "ObsHttpHandler: unsupported request body type (streaming is not used by this plugin)",
  );
}
