import {
  createSessionStream,
  type SessionStream,
  type SessionStreamOptions,
} from "./session-stream.js";
export type { SessionStream, SessionStreamOptions } from "./session-stream.js";
import type { Operation, OperationInputs } from "./catalog.js";
import { catalog } from "./catalog.js";
import { parseOperationResult, type OperationResults } from "./outputs.js";
import {
  createClientTransport,
  ClientTransportError,
  isClientControlPath,
  serializeClientJson,
} from "./client-transport.js";
import type {
  ClientExchange,
  ClientExchangeAuthority,
  ClientTransport,
} from "./client-transport.js";
export type { OperationResults } from "./outputs.js";
export {
  createClientTransport,
  serializeClientJson,
  clientJsonBytes,
  isClientExchangeForTransport,
} from "./client-transport.js";
export type {
  ClientExchange,
  ClientExchangeAuthority,
  ClientTransport,
  ClientTransportRequest,
} from "./client-transport.js";

/** Additive public hooks; an embedding must still supply its own native/receipt authority. */
export const supportsVerifiedClientIntegration = true;

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
// Only a fully validated remote error may bypass local response-failure revocation.
class RemoteAPIError extends APIError {}
export type ClientCallOptions = {
  signal?: AbortSignal;
  timeout?: number;
  authority?: ClientExchangeAuthority;
  /** JSON calls join the actual exchange tail, including errors and cancellation. */
  joinPhysical?: boolean;
  capacityClass?: "ordinary" | "control";
};
export type TransferOptions = ClientCallOptions & { progress?: (bytes: number) => void };
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
export interface ClientRegistration {
  readonly id: string;
  readonly kind: "agent" | "operator";
  readonly expiresInMs: number;
}
export interface ManagementClientOptions {
  /** Canonical transport unless an embedding supplies an explicit alternative. */
  transport?: ClientTransport;
  /** Invoked for every exchange; returns this exchange's actual owner checks. */
  authority?: (path: string, options: ClientCallOptions) => ClientExchangeAuthority;
  expectedKind?: "agent" | "operator";
  automaticHeartbeat?: boolean;
  onRegistered?: (
    registration: ClientRegistration,
    exchange: ClientExchange,
    state: { publish: boolean },
  ) => void;
  /** Retain a sent registration until its real response, then detach abandoned actors. */
  retainSentRegistration?: boolean;
  onExchange?: (exchange: ClientExchange, authority?: ClientExchangeAuthority) => void;
  capacity?: { ordinary: number; control: number };
  onInvalidated?: () => void;
  /** Default retains legacy best-effort close; strict callers receive cleanup failures. */
  strictCleanup?: boolean;
  strictLifecycle?: boolean;
}
function object(value: unknown): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    throw new APIError("API_RESPONSE", "Management API returned an invalid response.");
  return value as Record<string, unknown>;
}
export class ManagementClient {
  #token?: string;
  #identity?: ClientRegistration;
  #timer?: ReturnType<typeof setInterval>;
  #connecting?: Promise<this>;
  #closing?: Promise<void>;
  #closed = false;
  #cleanupSettled = false;
  #invalid = false;
  #pending = new Set<ClientExchange>();
  #revocations = new WeakMap<ClientExchange, () => void>();
  #streams = new Set<SessionStream>();
  #ordinary = 0;
  #control = 0;
  #transport: ClientTransport;
  #registrationExchange?: ClientExchange;
  #registrationAuthority?: ClientExchangeAuthority;
  #abandonedRegistrationAuthority?: ClientExchangeAuthority;
  #registrationAbandoned = false;
  readonly url: string;
  constructor(
    url: string,
    private bootstrapToken: string,
    private options: ManagementClientOptions = {},
  ) {
    this.url = assertLoopback(url);
    this.#transport = options.transport ?? createClientTransport();
  }
  get registration(): ClientRegistration | undefined {
    return this.#closed || this.#invalid ? undefined : this.#identity;
  }
  #invalidate(exchange?: ClientExchange) {
    const revoke = exchange?.sent ? this.#revocations.get(exchange) : undefined;
    revoke?.();
    if (!this.options.strictLifecycle && !this.options.authority && !revoke) return;
    if (this.#invalid) return;
    this.#invalid = true;
    clearInterval(this.#timer);
    for (const exchange of this.#pending) exchange.cancel();
    for (const stream of this.#streams) void stream.close();
    this.options.onInvalidated?.();
  }
  #start(
    path: string,
    body: unknown,
    options: {
      signal?: AbortSignal;
      timeout?: number;
      method?: "POST" | "GET" | "PUT";
      download?: boolean;
      upload?: ReadableStream<Uint8Array>;
      closing?: boolean;
      authority?: ClientExchangeAuthority;
      retainSent?: boolean;
      capacityClass?: "ordinary" | "control";
    } = {},
  ) {
    if (this.#invalid || (this.#closed && !options.closing))
      throw new APIError("NOT_CONNECTED", "This API client is no longer attached.");
    const registration = path === "/v1/clients";
    if (!registration && !this.#token)
      throw new APIError("NOT_CONNECTED", "Register this API client before making requests.");
    const method = path.slice(4) as Operation;
    const operatorRoute = Object.hasOwn(catalog, method) && catalog[method].operator;
    if (operatorRoute && this.#identity?.kind !== "operator")
      throw new APIError("FORBIDDEN", "This operation requires operator authority.");
    const requestBytes = options.upload
      ? 104857600
      : method === "ssh_vault_restore"
        ? 50331648
        : operatorRoute
          ? 16777216
          : 1048576;
    const responseBytes = options.download
      ? 104857600
      : method === "ssh_vault_backup"
        ? 50331648
        : Object.hasOwn(catalog, method)
          ? 16777216
          : 16384;
    const capacityClass =
      options.capacityClass === undefined
        ? path === "/v1/clients/heartbeat" || path === "/v1/clients/detach"
          ? "control"
          : "ordinary"
        : options.capacityClass;
    if (
      (capacityClass !== "ordinary" && capacityClass !== "control") ||
      (capacityClass === "control" && !isClientControlPath(path))
    )
      throw new APIError("INVALID_ARGUMENT", "Invalid client capacity class for this route.");
    const control = capacityClass === "control";
    if (this.options.capacity !== undefined) {
      const capacity = this.options.capacity;
      if (
        !capacity ||
        [capacity.ordinary, capacity.control].some(
          (value) => !Number.isSafeInteger(value) || value < 1,
        )
      )
        throw new APIError("INVALID_ARGUMENT", "Invalid client capacity.");
      if (
        (control ? this.#control : this.#ordinary) >=
        (control ? this.options.capacity.control : this.options.capacity.ordinary)
      )
        throw new APIError("LIMIT", "Client physical exchange capacity reached.");
    }
    const authority = options.authority ?? this.options.authority?.(path, options);
    authority?.assertCurrent();
    const timeout = options.timeout ?? (options.upload || options.download ? undefined : 30000);
    const signal = AbortSignal.any([
      ...(timeout === undefined ? [] : [AbortSignal.timeout(timeout)]),
      ...(options.signal && !options.retainSent ? [options.signal] : []),
    ]);
    // Both transport failures and local decoder failures revoke this exact owner once.
    let revoked = false;
    const revoke = () => {
      if (revoked) return;
      revoked = true;
      try {
        authority?.invalidate();
      } catch {
        /* Revocation reporting cannot interrupt cleanup. */
      }
    };
    const exchange = this.#transport.start({
      url: this.url + "/",
      path,
      token: registration ? this.bootstrapToken : this.#token!,
      method: options.method ?? "POST",
      ...(options.upload
        ? { body: options.upload }
        : options.method === "GET"
          ? {}
          : { json: body }),
      requestBytes,
      responseBytes,
      errorBytes: 16384,
      download: options.download,
      signal,
      abandonSignal: options.retainSent ? options.signal : undefined,
      capacityClass: control ? "control" : "ordinary",
      authority: authority && {
        assertCurrent: () => authority.assertCurrent(),
        beforeConnect: authority.beforeConnect ? () => authority.beforeConnect!() : undefined,
        beforeSend: (socket) => authority.beforeSend(socket),
        afterResponse: (socket) => authority.afterResponse(socket),
        sent: () => authority.sent?.(),
        invalidate: revoke,
      },
    });
    if (authority) this.#revocations.set(exchange, revoke);
    this.#pending.add(exchange);
    if (control) this.#control++;
    else this.#ordinary++;
    const retire = () => {
      this.#pending.delete(exchange);
      if (control) this.#control--;
      else this.#ordinary--;
    };
    void exchange.settled.then(retire, () => {
      retire();
      this.#invalidate(exchange);
    });
    try {
      this.options.onExchange?.(exchange, authority);
    } catch (error) {
      void exchange.result.catch(() => {});
      exchange.cancel();
      throw error;
    }
    return { exchange, authority };
  }
  #responseError(exchange: ClientExchange, error: unknown): APIError {
    if (error instanceof RemoteAPIError) return error;
    if (exchange.sent) this.#invalidate(exchange);
    if (error instanceof APIError) return error;
    return error instanceof ClientTransportError
      ? new APIError(error.code, error.message)
      : new APIError("API_RESPONSE", "Management API returned an invalid response.");
  }
  async #decode(exchange: ClientExchange): Promise<Record<string, unknown>> {
    try {
      const response = object(await exchange.result);
      if (Object.hasOwn(response, "stream")) return response;
      const body = object(response.body);
      if (response.ok !== true) {
        const error = object(body.error);
        if (typeof error.code !== "string" || typeof error.message !== "string")
          throw new APIError("API_RESPONSE", "Management API returned an invalid response.");
        throw new RemoteAPIError(
          error.code,
          error.message,
          error.details === undefined ? undefined : object(error.details),
        );
      }
      return body;
    } catch (error) {
      throw this.#responseError(exchange, error);
    }
  }
  connect(input?: AbortSignal | ClientCallOptions): Promise<this> {
    const options = input instanceof AbortSignal ? { signal: input } : (input ?? {});
    const signal = options.signal;
    if (
      this.#closed &&
      this.#cleanupSettled &&
      !this.options.strictLifecycle &&
      !this.options.authority
    ) {
      this.#closed = false;
      this.#closing = undefined;
      this.#connecting = undefined;
      this.#registrationExchange = undefined;
      this.#registrationAuthority = undefined;
      this.#abandonedRegistrationAuthority = undefined;
      this.#registrationAbandoned = false;
    }
    if (this.#closed || this.#invalid)
      return Promise.reject(
        new APIError("NOT_CONNECTED", "This API client is no longer attached."),
      );
    if (this.#token && !this.#closed && !this.#invalid) {
      if (!options.joinPhysical) return Promise.resolve(this);
      const exchange = this.#registrationExchange;
      if (!exchange)
        return Promise.reject(
          new APIError("NOT_CONNECTED", "Registration ownership is unavailable."),
        );
      return exchange.settled.then(() => {
        if (this.#closed || this.#invalid || signal?.aborted)
          throw new APIError("NOT_CONNECTED", "This API client is no longer attached.");
        return this;
      });
    }
    const ownsRegistration = !this.#connecting;
    if (ownsRegistration) {
      const attempt = this.#register(options);
      this.#connecting = attempt;
      void attempt.catch(() => {
        if (
          this.#connecting === attempt &&
          !this.options.strictLifecycle &&
          !this.options.authority &&
          !this.#closed
        )
          this.#connecting = undefined;
      });
    }
    const registrationExchange = this.#registrationExchange;
    const connected = this.#connecting!.then(async () => {
      // Ownership and cancellation remain live until the requested physical join.
      if (options.joinPhysical) await registrationExchange?.settled;
      if (this.#closed || this.#invalid || signal?.aborted)
        throw new APIError("NOT_CONNECTED", "This API client is no longer attached.");
      return this;
    });
    const joined = async (attempt: Promise<this>): Promise<this> => {
      try {
        return await attempt;
      } catch (error) {
        if (options.joinPhysical && this.#closed) await this.close();
        throw error;
      } finally {
        if (options.joinPhysical) await registrationExchange?.settled;
      }
    };
    if (!signal || (ownsRegistration && !this.options.retainSentRegistration))
      return joined(connected);
    return joined(
      new Promise<this>((resolve, reject) => {
        let completed = false;
        const abandon = () => {
          if (completed) return;
          completed = true;
          signal.removeEventListener("abort", abandon);
          if (ownsRegistration) {
            this.#registrationAbandoned = true;
            this.#abandonedRegistrationAuthority = this.#registrationAuthority;
            // Only the registration owner can abandon its private sent cleanup.
            void this.close().catch(() => {});
          }
          reject(new APIError("CANCELLED_OR_TIMEOUT", "Registration caller was cancelled."));
        };
        if (signal.aborted) abandon();
        else signal.addEventListener("abort", abandon, { once: true });
        void connected.then(
          (value) => {
            if (completed) return;
            completed = true;
            signal.removeEventListener("abort", abandon);
            resolve(value);
          },
          (error) => {
            if (completed) return;
            completed = true;
            signal.removeEventListener("abort", abandon);
            reject(error);
          },
        );
      }),
    );
  }

  async #register(options: ClientCallOptions): Promise<this> {
    const { signal } = options;
    const { exchange, authority } = this.#start(
      "/v1/clients",
      {},
      {
        ...options,
        timeout: options.timeout ?? 5000,
        retainSent: this.options.retainSentRegistration,
      },
    );
    this.#registrationExchange = exchange;
    this.#registrationAuthority = authority;
    try {
      const envelope = await this.#decode(exchange);
      const data = object(envelope.data);
      const actor = object(data.actor);
      if (
        Object.keys(envelope).length !== 1 ||
        Object.keys(data).length !== 3 ||
        Object.keys(actor).length !== 2 ||
        typeof actor.id !== "string" ||
        !/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(actor.id) ||
        !["agent", "operator"].includes(actor.kind as string) ||
        typeof data.token !== "string" ||
        !/^[A-Za-z0-9_-]{40,100}$/.test(data.token) ||
        !Number.isSafeInteger(data.expiresInMs) ||
        (data.expiresInMs as number) <= 0 ||
        (this.options.expectedKind && actor.kind !== this.options.expectedKind)
      )
        throw new APIError("API_RESPONSE", "Management API returned an invalid registration.");
      authority?.assertCurrent();
      if (this.#invalid)
        throw new APIError("NOT_CONNECTED", "This API client is no longer attached.");
      const publish = !this.#closed && !signal?.aborted;
      const identity = Object.freeze({
        id: actor.id,
        kind: actor.kind as "agent" | "operator",
        expiresInMs: data.expiresInMs as number,
      });
      this.#token = data.token;
      if (!publish) {
        this.#registrationAbandoned = true;
        this.#abandonedRegistrationAuthority = authority;
      }
      this.options.onRegistered?.(identity, exchange, { publish });
      if (this.#closed || signal?.aborted) {
        this.#registrationAbandoned = true;
        this.#abandonedRegistrationAuthority = authority;
      }
      authority?.assertCurrent();
      this.#identity = identity;
      if (publish && !this.#closed && this.options.automaticHeartbeat !== false) {
        this.#timer = setInterval(() => {
          void this.heartbeat().catch(() => this.#invalidate());
        }, 30000);
        this.#timer.unref();
      }
      return this;
    } catch (error) {
      // Preserve strict registration failure semantics without revoking an owner
      // for a structurally valid remote domain error.
      if (error instanceof RemoteAPIError && exchange.sent) this.#invalidate();
      throw this.#responseError(exchange, error);
    }
  }
  async #request<T>(
    path: string,
    body: unknown,
    options: ClientCallOptions & { closing?: boolean },
    decode: (response: Record<string, unknown>) => T,
  ): Promise<T> {
    const { exchange, authority } = this.#start(path, body, options);
    try {
      const response = await this.#decode(exchange);
      authority?.assertCurrent();
      return decode(response);
    } catch (error) {
      throw this.#responseError(exchange, error);
    } finally {
      if (options.joinPhysical) await exchange.settled;
    }
  }
  async heartbeat(options: ClientCallOptions = {}) {
    await this.#request(
      "/v1/clients/heartbeat",
      {},
      { ...options, timeout: options.timeout ?? 5000 },
      (reply) => {
        if (object(reply.data).alive !== true)
          throw new APIError("API_RESPONSE", "Management API rejected the client heartbeat.");
      },
    );
  }
  async call<K extends Operation>(
    operation: K,
    args: OperationInputs[K],
    options: ClientCallOptions = {},
  ): Promise<OperationResults[K]> {
    return this.#request(`/v1/${operation}`, args, options, (response) => {
      try {
        return parseOperationResult(operation, response);
      } catch {
        throw new APIError("API_RESPONSE", "Management API returned an invalid operation result.");
      }
    });
  }
  async download(targetId: string, path: string, input?: AbortSignal | TransferOptions) {
    const options = transferOptions(input);
    const { exchange, authority } = this.#start(
      `/v1/files/download?${new URLSearchParams({ targetId, path })}`,
      undefined,
      { ...options, method: "GET", download: true },
    );
    try {
      const reply = await this.#decode(exchange);
      authority?.assertCurrent();
      if (!(reply.stream instanceof ReadableStream))
        throw new APIError("API_RESPONSE", "Management API returned an invalid download stream.");
      const stream = reply.stream as ReadableStream<Uint8Array>;
      return options.progress ? stream.pipeThrough(progressStream(options.progress)) : stream;
    } catch (error) {
      throw this.#responseError(exchange, error);
    }
  }
  async upload(
    targetId: string,
    path: string,
    stream: ReadableStream<Uint8Array>,
    input?: AbortSignal | TransferOptions,
  ) {
    const options = transferOptions(input);
    const { exchange, authority } = this.#start(
      `/v1/files/upload?${new URLSearchParams({ targetId, path })}`,
      undefined,
      {
        ...options,
        method: "PUT",
        upload: options.progress ? stream.pipeThrough(progressStream(options.progress)) : stream,
      },
    );
    try {
      const reply = await this.#decode(exchange);
      authority?.assertCurrent();
      if (object(reply.data).completed !== true)
        throw new APIError("API_RESPONSE", "Management API returned an invalid transfer result.");
      return { completed: true };
    } catch (error) {
      throw this.#responseError(exchange, error);
    }
  }
  async stopRuntime(options: ClientCallOptions = {}) {
    if (this.#identity?.kind !== "operator")
      throw new APIError("FORBIDDEN", "Runtime stop requires operator authority.");
    return this.#request("/v1/runtime/stop", {}, options, (reply) => reply);
  }
  watchSession(sessionId: string, options: SessionStreamOptions): SessionStream {
    if (this.#closed || this.#invalid || !this.#token)
      throw new APIError(
        "NOT_CONNECTED",
        "Register this API client before opening session events.",
      );
    if (this.#streams.size >= 128) throw new APIError("LIMIT", "Session stream capacity reached.");
    const stream = createSessionStream(this.url, this.#token, sessionId, options);
    this.#streams.add(stream);
    void stream.settled.then(() => this.#streams.delete(stream));
    return stream;
  }
  close(
    options: { authority?: ClientExchangeAuthority; capacityClass?: "ordinary" | "control" } = {},
  ): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#closed = true;
    clearInterval(this.#timer);
    const pending = [...this.#pending];
    for (const exchange of pending)
      if (
        !exchange.responseComplete &&
        !(
          this.options.retainSentRegistration &&
          exchange === this.#registrationExchange &&
          exchange.sent
        )
      )
        exchange.cancel();
    this.#closing = (async () => {
      try {
        const tails = await Promise.allSettled([
          ...pending.map((exchange) => exchange.settled),
          ...[...this.#streams].map((stream) => stream.close()),
        ]);
        await this.#connecting?.catch(() => {});
        for (const tail of tails) if (tail.status === "rejected") throw tail.reason;
        if (this.#token) {
          const { exchange } = this.#start(
            "/v1/clients/detach",
            {},
            {
              timeout: 2000,
              closing: true,
              authority: this.#abandonedRegistrationAuthority ?? options.authority,
              capacityClass: this.#registrationAbandoned
                ? "ordinary"
                : (options.capacityClass ?? "control"),
            },
          );
          let response: Record<string, unknown>;
          try {
            response = await this.#decode(exchange);
            if (object(response.data).detached !== true)
              throw new APIError("API_RESPONSE", "Management API did not confirm client detach.");
          } catch (error) {
            throw this.#responseError(exchange, error);
          } finally {
            await exchange.settled;
          }
        }
        this.#token = undefined;
        this.#identity = undefined;
        this.#cleanupSettled = true;
      } catch (error) {
        if (this.options.strictCleanup) throw error;
        this.#token = undefined;
        this.#identity = undefined;
        this.#cleanupSettled = true;
      }
    })();
    return this.#closing;
  }
}
