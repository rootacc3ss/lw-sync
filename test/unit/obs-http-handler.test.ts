import { describe, test, expect, vi } from "vitest";
import { HttpRequest } from "@smithy/core/protocols";
import type { requestUrl } from "obsidian";
import { ObsHttpHandler } from "../../src/store/obs-http-handler";

type RequestFn = typeof requestUrl;
type FakeResponse = { status: number; headers: Record<string, string>; arrayBuffer: ArrayBuffer };

function makeReq(over: Partial<HttpRequest> = {}): HttpRequest {
  return new HttpRequest({
    method: "PUT",
    protocol: "https:",
    hostname: "s3.example.test",
    port: 8443,
    path: "/bucket/key",
    query: { "list-type": "2" },
    headers: { host: "s3.example.test:8443", "content-length": "5", "x-amz-meta-x": "Y" },
    body: new Uint8Array([104, 105]), // "hi"
    ...over,
  });
}

function makeRsp(status = 200, headers: Record<string, string> = {}, body = "ok"): FakeResponse {
  return { status, headers, arrayBuffer: new TextEncoder().encode(body).buffer as ArrayBuffer };
}

describe("ObsHttpHandler", () => {
  test("builds the URL from protocol/hostname/port/path/query", async () => {
    const fn = vi.fn(async (_p: unknown) => makeRsp());
    const h = new ObsHttpHandler(fn as unknown as RequestFn);
    await h.handle(makeReq());
    const p = fn.mock.calls[0][0] as { url: string; method: string };
    expect(p.url).toBe("https://s3.example.test:8443/bucket/key?list-type=2");
    expect(p.method).toBe("PUT");
  });

  test("strips host/content-length and lowercases forwarded headers", async () => {
    const fn = vi.fn(async (_p: unknown) => makeRsp());
    const h = new ObsHttpHandler(fn as unknown as RequestFn);
    await h.handle(makeReq());
    const p = fn.mock.calls[0][0] as { headers: Record<string, string> };
    expect(p.headers).toEqual({ "x-amz-meta-x": "Y" });
  });

  test("converts a Uint8Array body to ArrayBuffer; GET sends no body", async () => {
    const fn = vi.fn(async (_p: unknown) => makeRsp());
    const h = new ObsHttpHandler(fn as unknown as RequestFn);
    await h.handle(makeReq());
    expect((fn.mock.calls[0][0] as { body: ArrayBuffer }).body).toBeInstanceOf(ArrayBuffer);

    await h.handle(makeReq({ method: "GET", body: undefined }));
    expect((fn.mock.calls[1][0] as { body?: ArrayBuffer }).body).toBeUndefined();
  });

  test("maps the response: status + lowercased headers + byte stream body", async () => {
    const fn = vi.fn(async () => makeRsp(201, { ETag: '"x"', "Content-Type": "text/plain" }));
    const h = new ObsHttpHandler(fn as unknown as RequestFn);
    const { response } = await h.handle(makeReq());
    expect(response.statusCode).toBe(201);
    expect(response.headers).toEqual({ etag: '"x"', "content-type": "text/plain" });
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value!)).toBe("ok");
    expect((await reader.read()).done).toBe(true);
  });

  test("an already-aborted signal throws before issuing the request", async () => {
    const fn = vi.fn(async (_p: unknown) => makeRsp());
    const h = new ObsHttpHandler(fn as unknown as RequestFn);
    await expect(
      h.handle(makeReq(), { abortSignal: { aborted: true, onabort: null } }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(fn).not.toHaveBeenCalled();
  });

  test("an abort raised mid-flight rejects the request", async () => {
    const fn = vi.fn(() => new Promise<FakeResponse>(() => {})); // hangs until aborted
    const h = new ObsHttpHandler(fn as unknown as RequestFn);
    const signal = { aborted: false, onabort: null };
    const run = h.handle(makeReq(), { abortSignal: signal });
    await Promise.resolve();
    (signal.onabort as unknown as () => void)();
    await expect(run).rejects.toMatchObject({ name: "AbortError" });
  });

  test("a request exceeding the timeout rejects with TimeoutError", async () => {
    const fn = vi.fn(() => new Promise<FakeResponse>(() => {})); // never settles
    const h = new ObsHttpHandler(fn as unknown as RequestFn, 10);
    await expect(h.handle(makeReq())).rejects.toMatchObject({ name: "TimeoutError" });
  });

  test("a rejecting request propagates the error (no swallowed failures)", async () => {
    const fn = vi.fn(async () => {
      throw new Error("boom");
    });
    const h = new ObsHttpHandler(fn as unknown as RequestFn);
    await expect(h.handle(makeReq())).rejects.toThrow("boom");
  });
});
