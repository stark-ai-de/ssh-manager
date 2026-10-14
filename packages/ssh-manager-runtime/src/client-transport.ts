import { Agent, request } from "node:http";
import { createConnection } from "node:net";
import type { ClientRequest, IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import { Readable, Transform } from "node:stream";
import { types } from "node:util";

export interface ClientExchangeAuthority {
  assertCurrent(): void;
  beforeConnect?(): Promise<void>;
  beforeSend(socket: Socket): Promise<void>;
  afterResponse(socket: Socket): Promise<void>;
  /** Runs synchronously immediately before the first potentially effective write. */
  sent?(): void;
  /** Sent failures must revoke the same owner used by subsequent requests. */
  invalidate(): void;
}
export interface ClientTransportRequest {
  readonly url: string;
  readonly path: string;
  readonly token: string;
  readonly method: "POST" | "GET" | "PUT";
  readonly body?: string | ReadableStream<Uint8Array>;
  readonly json?: unknown;
  readonly requestBytes: number;
  readonly responseBytes: number;
  readonly errorBytes?: number;
  readonly download?: boolean;
  readonly signal: AbortSignal;
  /** Caller cancellation stops unsent work; sent registration cleanup continues privately. */
  readonly abandonSignal?: AbortSignal;
  readonly authority?: ClientExchangeAuthority;
  readonly capacityClass?: "ordinary" | "control";
}
export interface ClientExchange {
  readonly result: Promise<unknown>;
  /** Work, authority checks, decoder/upload/download and actual socket close. */
  readonly settled: Promise<void>;
  readonly sent: boolean;
  /** Fully consumed response; physical settlement is still independently required. */
  readonly responseComplete: boolean;
  cancel(): void;
}
export interface ClientTransport {
  start(request: ClientTransportRequest): ClientExchange;
}
const exchangeOwners = new WeakMap<ClientExchange, ClientTransport>();
/** Origin only: this does not prove native authority, an admission ticket or settlement. */
export function isClientExchangeForTransport(
  transport: ClientTransport,
  exchange: ClientExchange,
): boolean {
  return exchangeOwners.get(exchange) === transport;
}
export class ClientTransportError extends Error {
  constructor(
    readonly code: "LIMIT" | "API_RESPONSE" | "API_UNAVAILABLE" | "CANCELLED_OR_TIMEOUT",
    readonly sent: boolean,
  ) {
    super("Local management API request could not be completed.");
  }
}

/** Counts before materializing JSON. No accessors, toJSON, cycles or nonfinite values. */
export function clientJsonBytes(value: unknown, maxBytes: number): number {
  let bytes = 0;
  const active = new Set<object>();
  const add = (count: number) => {
    bytes += count;
    if (bytes > maxBytes) throw new ClientTransportError("LIMIT", false);
  };
  const string = (text: string) => {
    add(2);
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      if (c === 34 || c === 92 || [8, 9, 10, 12, 13].includes(c)) add(2);
      else if (c < 32) add(6);
      else if (c < 128) add(1);
      else if (c < 2048) add(2);
      else if (
        c >= 0xd800 &&
        c <= 0xdbff &&
        i + 1 < text.length &&
        text.charCodeAt(i + 1) >= 0xdc00 &&
        text.charCodeAt(i + 1) <= 0xdfff
      ) {
        add(4);
        i++;
      } else if (c >= 0xd800 && c <= 0xdfff) add(6);
      else add(3);
    }
  };
  const visit = (v: unknown): void => {
    if (v === null) {
      add(4);
      return;
    }
    if (typeof v === "string") {
      string(v);
      return;
    }
    if (typeof v === "boolean") {
      add(v ? 4 : 5);
      return;
    }
    if (typeof v === "number" && Number.isFinite(v)) {
      add(String(v).length);
      return;
    }
    if (!v || typeof v !== "object" || types.isProxy(v) || active.has(v))
      throw new ClientTransportError("API_RESPONSE", false);
    const array = Array.isArray(v);
    const descriptors = Object.getOwnPropertyDescriptors(v);
    for (const key of Reflect.ownKeys(descriptors)) {
      const descriptor = descriptors[key as string]!;
      if (typeof key !== "string" || !Object.hasOwn(descriptor, "value") || key === "toJSON")
        throw new ClientTransportError("API_RESPONSE", false);
    }
    if (!array && Object.getPrototypeOf(v) !== Object.prototype)
      throw new ClientTransportError("API_RESPONSE", false);
    active.add(v);
    add(2);
    const keys = Object.keys(v).filter((key) => {
      const d = Object.getOwnPropertyDescriptor(v, key);
      return array || !d || !Object.hasOwn(d, "value") || d.value !== undefined;
    });
    if (array && keys.length !== v.length) throw new ClientTransportError("API_RESPONSE", false);
    for (let i = 0; i < keys.length; i++) {
      if (i) add(1);
      const key = keys[i]!;
      if (array && key !== String(i)) throw new ClientTransportError("API_RESPONSE", false);
      const descriptor = Object.getOwnPropertyDescriptor(v, key);
      if (!descriptor || !Object.hasOwn(descriptor, "value"))
        throw new ClientTransportError("API_RESPONSE", false);
      if (!array) {
        string(key);
        add(1);
      }
      visit(descriptor.value);
    }
    active.delete(v);
  };
  visit(value);
  return bytes;
}
export function serializeClientJson(value: unknown, maxBytes: number): string {
  clientJsonBytes(value, maxBytes);
  // Encode only validated primitive leaves. JSON.stringify never sees the source object
  // or its prototype, so no inherited/non-enumerable toJSON can bypass the preflight.
  const encode = (v: unknown): string => {
    if (v === null || typeof v !== "object") return JSON.stringify(v);
    if (Array.isArray(v)) {
      const parts: string[] = [];
      for (let i = 0; i < v.length; i++)
        parts.push(encode(Object.getOwnPropertyDescriptor(v, String(i))!.value));
      return "[" + parts.join(",") + "]";
    }
    return (
      "{" +
      Object.keys(v)
        .filter((key) => Object.getOwnPropertyDescriptor(v, key)!.value !== undefined)
        .map(
          (key) =>
            JSON.stringify(key) + ":" + encode(Object.getOwnPropertyDescriptor(v, key)!.value),
        )
        .join(",") +
      "}"
    );
  };
  return encode(value);
}

/** One fresh HTTP connection per exchange. Authority is supplied by trusted embedding code. */
export function createClientTransport(
  options: { capacity?: { ordinary: number; control: number } } = {},
): ClientTransport {
  const active = { ordinary: 0, control: 0 };
  if (
    options.capacity &&
    [options.capacity.ordinary, options.capacity.control].some(
      (value) => !Number.isSafeInteger(value) || value < 1,
    )
  )
    throw new ClientTransportError("LIMIT", false);
  const transport: ClientTransport = {
    start(input) {
      let admitted = false;
      const capacityClass = input.capacityClass ?? "ordinary";
      let sent = false;
      let responseComplete = false;
      let req: ClientRequest | undefined;
      let agent: Agent | undefined;
      let socket: Socket | undefined;
      let uploadSource: Readable | undefined;
      let downloadSink: Transform | undefined;

      let resolve!: (value: unknown) => void;
      let reject!: (error: unknown) => void;
      let resultEnded = false;
      let invalidated = false;
      const result = new Promise<unknown>((yes, no) => {
        resolve = yes;
        reject = no;
      });
      const finish = (value: unknown) => {
        if (!resultEnded) {
          resultEnded = true;
          resolve(value);
        }
      };
      const fail = (code: ClientTransportError["code"]) => {
        if (sent && !invalidated) {
          invalidated = true;
          try {
            input.authority?.invalidate();
          } catch {
            /* Deny this exchange even if notification fails. */
          }
        }
        if (!resultEnded) {
          resultEnded = true;
          reject(new ClientTransportError(code, sent));
        }
        const error = new ClientTransportError(code, sent);
        downloadSink?.destroy(error);
        uploadSource?.destroy(error);
        req?.destroy();
        agent?.destroy();
        socket?.destroy();
      };
      const cancel = () => fail("CANCELLED_OR_TIMEOUT");
      input.signal.addEventListener("abort", cancel, { once: true });
      const abandon = () => {
        if (!sent) cancel();
      };
      input.abandonSignal?.addEventListener("abort", abandon, { once: true });
      const work = Promise.resolve().then(async () => {
        let socketClose: Promise<void> = Promise.resolve();
        let upload: Promise<void> | undefined;
        let uploadClose: Promise<void> = Promise.resolve();
        try {
          if (capacityClass !== "ordinary" && capacityClass !== "control")
            throw new ClientTransportError("API_RESPONSE", false);
          if (
            capacityClass === "control" &&
            !["/v1/clients/heartbeat", "/v1/clients/detach", "/v1/ssh_session_detach"].includes(
              input.path,
            )
          )
            throw new ClientTransportError("API_RESPONSE", false);
          if (options.capacity && active[capacityClass] >= options.capacity[capacityClass])
            throw new ClientTransportError("LIMIT", false);
          active[capacityClass]++;
          admitted = true;
          if (input.signal.aborted || input.abandonSignal?.aborted || resultEnded)
            throw new ClientTransportError("CANCELLED_OR_TIMEOUT", false);
          const endpoint = new URL(input.url);
          if (
            endpoint.protocol !== "http:" ||
            !["127.0.0.1", "[::1]"].includes(endpoint.hostname) ||
            endpoint.username ||
            endpoint.password ||
            endpoint.search ||
            endpoint.hash ||
            endpoint.pathname !== "/" ||
            !/^\/v1\//.test(input.path) ||
            /[\r\n#]/.test(input.path)
          )
            throw new ClientTransportError("API_RESPONSE", false);
          for (const cap of [input.requestBytes, input.responseBytes, input.errorBytes ?? 16384])
            if (!Number.isSafeInteger(cap) || cap < 1)
              throw new ClientTransportError("LIMIT", false);
          if (typeof input.token !== "string" || !/^[A-Za-z0-9_-]{1,4096}$/.test(input.token))
            throw new ClientTransportError("API_RESPONSE", false);
          input.authority?.assertCurrent();
          const body = Object.hasOwn(input, "json")
            ? serializeClientJson(input.json, input.requestBytes)
            : input.body;
          if (typeof body === "string" && Buffer.byteLength(body) > input.requestBytes)
            throw new ClientTransportError("LIMIT", false);
          input.authority?.assertCurrent();
          await input.authority?.beforeConnect?.();
          input.authority?.assertCurrent();
          if (resultEnded) throw new ClientTransportError("CANCELLED_OR_TIMEOUT", false);
          let responseResolve!: (value: IncomingMessage) => void;
          let responseReject!: (error: unknown) => void;
          const responseReady = new Promise<IncomingMessage>((yes, no) => {
            responseResolve = yes;
            responseReject = no;
          });
          void responseReady.catch(() => {});
          // One fresh agent per exchange; never reused or shared. Keep its one socket alive
          // through post-response native proof, then join actual close before refunding admission.
          agent = new Agent({ keepAlive: true, maxSockets: 1, maxFreeSockets: 1 });
          agent.createConnection = () => {
            const actual = createConnection({
              host: endpoint.hostname === "[::1]" ? "::1" : endpoint.hostname,
              port: Number(endpoint.port || "80"),
            });
            socket = actual;
            socketClose = new Promise<void>((done) =>
              actual.once("close", () => {
                if (uploadSource && !uploadSource.readableEnded)
                  uploadSource.destroy(new ClientTransportError("API_UNAVAILABLE", sent));
                done();
              }),
            );
            return actual;
          };
          req = request(
            {
              hostname: endpoint.hostname === "[::1]" ? "::1" : endpoint.hostname,
              port: endpoint.port,
              path: input.path,
              method: input.method,
              agent,
              headers: {
                authorization: `Bearer ${input.token}`,
                connection: "keep-alive",
                ...(input.method === "GET"
                  ? {}
                  : {
                      "content-type":
                        typeof body === "string" ? "application/json" : "application/octet-stream",
                    }),
              },
            },
            responseResolve,
          );
          req.once("error", responseReject);
          const connected = await new Promise<Socket>((yes, no) => {
            req!.once("error", no);
            req!.once("socket", (actual) => {
              if (actual !== socket) {
                no(new ClientTransportError("API_RESPONSE", false));
                return;
              }
              actual.once("error", no);
              if (!actual.connecting) yes(actual);
              else actual.once("connect", () => yes(actual));
            });
          });
          input.authority?.assertCurrent();
          await input.authority?.beforeSend(connected);
          input.authority?.assertCurrent();
          if (resultEnded || connected.destroyed || req.socket !== connected)
            throw new ClientTransportError("CANCELLED_OR_TIMEOUT", false);
          sent = true;
          input.authority?.sent?.();

          if (body && typeof body !== "string") {
            const source = Readable.fromWeb(
              body as import("node:stream/web").ReadableStream<Uint8Array>,
            );
            uploadSource = source;
            uploadClose = new Promise<void>((resolve) => source.once("close", resolve));
            let count = 0;
            upload = new Promise<void>((yes, no) => {
              source.on("data", (chunk: Buffer) => {
                count += chunk.length;
                if (count > input.requestBytes) {
                  source.destroy(new ClientTransportError("LIMIT", true));
                  return;
                }
                if (!req!.write(chunk)) {
                  source.pause();
                  req!.once("drain", () => source.resume());
                }
              });
              source.once("end", () => {
                req!.end(yes);
              });
              source.once("error", no);
              req!.once("error", (error) => {
                source.destroy();
                no(error);
              });
            });
            void upload.catch((error) => {
              responseReject(error);
              req?.destroy();
            });
          } else req.end(body);
          const response = await responseReady;
          const success = (response.statusCode ?? 0) >= 200 && (response.statusCode ?? 0) < 300;
          const cap = success ? input.responseBytes : (input.errorBytes ?? 16384);
          if (
            response.headers["content-encoding"] ||
            ((response.statusCode ?? 0) >= 300 && (response.statusCode ?? 0) < 400)
          )
            throw new ClientTransportError("API_RESPONSE", true);
          const length = response.headers["content-length"];
          if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > cap))
            throw new ClientTransportError("LIMIT", true);
          let count = 0;
          if (input.download && success) {
            const bounded = new Transform({
              transform(chunk: Buffer, _encoding, done) {
                count += chunk.length;
                if (count > cap) done(new ClientTransportError("LIMIT", true));
                else done(null, chunk);
              },
            });
            downloadSink = bounded;
            const ended = new Promise<void>((yes, no) => {
              bounded.once("end", yes);
              bounded.once("error", no);
              bounded.once("close", () => {
                if (!bounded.readableEnded) no(new ClientTransportError("API_UNAVAILABLE", true));
              });
              response.once("error", (error) => bounded.destroy(error));
              response.once("aborted", () =>
                bounded.destroy(new ClientTransportError("API_UNAVAILABLE", true)),
              );
            });
            void ended.catch(() => {});
            input.authority?.assertCurrent();
            await input.authority?.afterResponse(connected);
            input.authority?.assertCurrent();
            response.pipe(bounded);
            finish({
              stream: Readable.toWeb(bounded, {
                strategy: { highWaterMark: 65536, size: (chunk: Uint8Array) => chunk.byteLength },
              }),
            });
            await ended;
            responseComplete = true;
          } else {
            if (
              !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(
                String(response.headers["content-type"] ?? ""),
              )
            )
              throw new ClientTransportError("API_RESPONSE", true);
            const chunks: Buffer[] = [];
            for await (const chunk of response) {
              const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
              count += bytes.length;
              if (count > cap) throw new ClientTransportError("LIMIT", true);
              chunks.push(bytes);
            }
            let data: unknown;
            try {
              data = JSON.parse(
                new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, count)),
              );
            } catch {
              throw new ClientTransportError("API_RESPONSE", true);
            }
            input.authority?.assertCurrent();
            await input.authority?.afterResponse(connected);
            input.authority?.assertCurrent();
            if (resultEnded) throw new ClientTransportError("CANCELLED_OR_TIMEOUT", true);
            // A complete response cannot certify an unfinished input stream. Stop it now,
            // after peer proof, and retain physical admission through its actual cancellation.
            if (uploadSource && !uploadSource.readableEnded)
              throw new ClientTransportError("API_RESPONSE", true);
            await upload;
            input.authority?.assertCurrent();
            if (resultEnded) throw new ClientTransportError("CANCELLED_OR_TIMEOUT", true);
            responseComplete = true;
            finish({ ok: success, body: data });
          }
          await upload;
        } catch (error) {
          fail(error instanceof ClientTransportError ? error.code : "API_UNAVAILABLE");
        } finally {
          req?.destroy();
          agent?.destroy();
          socket?.destroy();
          uploadSource?.destroy();
          await Promise.all([socketClose, uploadClose, upload?.catch(() => {})]);
          if (admitted) active[capacityClass]--;
          input.signal.removeEventListener("abort", cancel);
          input.abandonSignal?.removeEventListener("abort", abandon);
        }
      });
      const exchange: ClientExchange = Object.freeze({
        result,
        settled: work,
        get sent() {
          return sent;
        },
        get responseComplete() {
          return responseComplete;
        },
        cancel,
      });
      exchangeOwners.set(exchange, transport);
      return exchange;
    },
  };
  return transport;
}
