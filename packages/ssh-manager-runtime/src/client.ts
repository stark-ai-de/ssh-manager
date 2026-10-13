import type { Operation, OperationInputs } from "./catalog.js";
import { parseOperationResult, type OperationResults } from "./outputs.js";
export type { OperationResults } from "./outputs.js";

export class APIError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "APIError";
  }
}
export type TransferOptions = { signal?: AbortSignal; progress?: (bytes: number) => void };
function transferOptions(input?: AbortSignal | TransferOptions): TransferOptions {
  return input instanceof AbortSignal ? { signal: input } : (input ?? {});
}
function progressStream(progress?: (bytes: number) => void) {
  let bytes = 0;
  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      bytes += chunk.byteLength;
      progress?.(bytes);
      controller.enqueue(chunk);
    },
  });
}
export function assertLoopback(url: string) {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new APIError(
      "INVALID_ENDPOINT",
      "Management API must be authenticated local loopback HTTP.",
    );
  }
  if (
    parsed.protocol !== "http:" ||
    !["127.0.0.1", "[::1]"].includes(parsed.hostname) ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  )
    throw new APIError(
      "INVALID_ENDPOINT",
      "Management API must be authenticated local loopback HTTP.",
    );
  return parsed.origin;
}
export class ManagementClient {
  private token?: string;
  private timer?: ReturnType<typeof setInterval>;
  readonly url: string;
  constructor(
    url: string,
    private bootstrapToken: string,
  ) {
    this.url = assertLoopback(url);
  }
  async connect(signal?: AbortSignal) {
    if (this.token) return this;
    const response = await fetch(`${this.url}/v1/clients`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.bootstrapToken}`,
        "content-type": "application/json",
      },
      body: "{}",
      signal: AbortSignal.any([AbortSignal.timeout(5000), ...(signal ? [signal] : [])]),
    });
    const body = await this.decode(response);
    this.token = body.data.token;
    this.timer = setInterval(() => {
      void this.request("/v1/clients/heartbeat", {}, { timeout: 5000 }).catch(() => {});
    }, 30000);
    this.timer.unref();
    return this;
  }
  private async decode(response: Response) {
    let body: any;
    try {
      body = await response.json();
    } catch {
      throw new APIError("API_RESPONSE", "Management API returned an invalid response.");
    }
    if (!response.ok)
      throw new APIError(
        body.error?.code ?? "API_FAILED",
        body.error?.message ?? "Management API request failed.",
        body.error?.details,
      );
    return body;
  }
  private async request(
    route: string,
    body: unknown,
    options: { signal?: AbortSignal; timeout?: number } = {},
  ) {
    if (!this.token)
      throw new APIError("NOT_CONNECTED", "Register this API client before making requests.");
    const signal = AbortSignal.any([
      AbortSignal.timeout(options.timeout ?? 30000),
      ...(options.signal ? [options.signal] : []),
    ]);
    try {
      const response = await fetch(`${this.url}${route}`, {
        method: "POST",
        headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
        signal,
      });
      return await this.decode(response);
    } catch (error) {
      if (error instanceof APIError) throw error;
      throw new APIError(
        signal.aborted ? "CANCELLED_OR_TIMEOUT" : "API_UNAVAILABLE",
        "Local management API request was interrupted.",
      );
    }
  }
  async call<K extends Operation>(
    operation: K,
    args: OperationInputs[K],
    options: { signal?: AbortSignal; timeout?: number } = {},
  ): Promise<OperationResults[K]> {
    const response = await this.request(`/v1/${operation}`, args, options);
    try {
      return parseOperationResult(operation, response);
    } catch {
      // Schema issues may contain remote values; do not expose them or retry the operation.
      throw new APIError("API_RESPONSE", "Management API returned an invalid operation result.");
    }
  }
  async download(targetId: string, path: string, input?: AbortSignal | TransferOptions) {
    const options = transferOptions(input);
    if (!this.token) throw new APIError("NOT_CONNECTED", "Register this API client first.");
    const response = await fetch(
      `${this.url}/v1/files/download?${new URLSearchParams({ targetId, path })}`,
      { headers: { authorization: `Bearer ${this.token}` }, signal: options.signal },
    );
    if (!response.ok) await this.decode(response);
    return options.progress
      ? response.body!.pipeThrough(progressStream(options.progress))
      : response.body!;
  }
  async upload(
    targetId: string,
    path: string,
    stream: ReadableStream<Uint8Array>,
    input?: AbortSignal | TransferOptions,
  ) {
    const options = transferOptions(input);
    if (!this.token) throw new APIError("NOT_CONNECTED", "Register this API client first.");
    const response = await fetch(
      `${this.url}/v1/files/upload?${new URLSearchParams({ targetId, path })}`,
      {
        method: "PUT",
        headers: {
          authorization: `Bearer ${this.token}`,
          "content-type": "application/octet-stream",
        },
        body: (options.progress
          ? stream.pipeThrough(progressStream(options.progress))
          : stream) as any,
        duplex: "half",
        signal: options.signal,
      } as RequestInit,
    );
    return (await this.decode(response)).data as { completed: boolean };
  }
  async stopRuntime() {
    return this.request("/v1/runtime/stop", {});
  }
  async close() {
    if (this.timer) clearInterval(this.timer);
    if (this.token) {
      try {
        await this.request("/v1/clients/detach", {}, { timeout: 2000 });
      } catch {
        /* Detach is also enforced by client expiry after daemon loss. */
      }
    }
    this.token = undefined;
  }
}
