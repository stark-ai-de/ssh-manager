import { Agent } from "node:http";
import { createConnection, type Socket } from "node:net";
import WebSocket from "ws";
import type { ManagerEvent } from "@stark-ai/ssh-manager/contracts";
import { parseOperationResult, type OperationResults } from "./outputs.js";
import {
  serializeClientJson,
  ClientTransportError,
  type ClientExchangeAuthority,
} from "./client-transport.js";

export interface SessionStreamOptions {
  signal?: AbortSignal;
  authority: ClientExchangeAuthority;
  messageBytes?: number;
  queuedBytes?: number;
  queuedMessages?: number;
}
export interface SessionStream {
  readonly ready: Promise<OperationResults["ssh_session_attach"]>;
  readonly events: AsyncIterable<ManagerEvent>;
  /** Actual socket, upgrade/proof, auth write, decoder and websocket completion. */
  readonly settled: Promise<void>;
  close(): Promise<void>;
}

/** Canonical read-only session event connection. The embedding still owns native proof. */
export function createSessionStream(
  url: string,
  token: string,
  sessionId: string,
  options: SessionStreamOptions,
): SessionStream {
  const endpoint = new URL(url);
  if (
    endpoint.protocol !== "http:" ||
    !["127.0.0.1", "[::1]"].includes(endpoint.hostname) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(sessionId)
  )
    throw new ClientTransportError("API_RESPONSE", false);
  const caps = {
    message: options.messageBytes ?? 16777216,
    bytes: options.queuedBytes ?? 1048576,
    messages: options.queuedMessages ?? 64,
  };
  if (Object.values(caps).some((value) => !Number.isSafeInteger(value) || value < 1))
    throw new ClientTransportError("LIMIT", false);
  let socket: Socket | undefined, ws: WebSocket | undefined;
  let stopped = false,
    sent = false,
    attached = false,
    failure: Error | undefined;
  let targetId: string | undefined;
  let bytes = 0;
  const queue: { event: ManagerEvent; bytes: number }[] = [];
  let notify: (() => void) | undefined;
  let readyResolve!: (value: OperationResults["ssh_session_attach"]) => void,
    readyReject!: (error: Error) => void;
  const ready = new Promise<OperationResults["ssh_session_attach"]>((yes, no) => {
    readyResolve = yes;
    readyReject = no;
  });
  void ready.catch(() => {});
  let socketClosed: Promise<void> = Promise.resolve();
  let authWrite: Promise<void> = Promise.resolve();
  let websocketResolve!: () => void;
  const websocketClosed = new Promise<void>((resolve) => {
    websocketResolve = resolve;
  });
  const stop = (error?: Error) => {
    if (stopped) return;
    stopped = true;
    failure = error
      ? error instanceof ClientTransportError
        ? error
        : new ClientTransportError("API_UNAVAILABLE", sent)
      : undefined;
    if (error && sent) {
      try {
        options.authority.invalidate();
      } catch {}
    }
    if (!attached) readyReject(failure ?? new ClientTransportError("CANCELLED_OR_TIMEOUT", sent));
    queue.length = 0;
    bytes = 0;
    notify?.();
    ws?.terminate();
    socket?.destroy();
  };
  const abort = () => stop(new ClientTransportError("CANCELLED_OR_TIMEOUT", sent));
  options.signal?.addEventListener("abort", abort, { once: true });
  const agent = new Agent({ keepAlive: false });
  let proof: Promise<void> = Promise.resolve();
  agent.createConnection = (_connectOptions, callback) => {
    const actual = createConnection({
      host: endpoint.hostname === "[::1]" ? "::1" : endpoint.hostname,
      port: Number(endpoint.port || 80),
    });
    socket = actual;
    socketClosed = new Promise<void>((resolve) => actual.once("close", resolve));
    proof = (async () => {
      await new Promise<void>((resolve, reject) => {
        actual.once("connect", resolve);
        actual.once("error", reject);
        actual.once("close", () => reject(new Error("Connection closed before proof")));
      });
      options.authority.assertCurrent();
      await options.authority.beforeSend(actual);
      options.authority.assertCurrent();
      if (stopped || actual.destroyed)
        throw new ClientTransportError("CANCELLED_OR_TIMEOUT", false);
      sent = true;
      options.authority.sent?.();
      callback?.(null, actual);
    })().catch((error) => {
      callback?.(error as Error, actual);
      stop(error as Error);
    });
    // Withhold the actual socket from the HTTP agent until proof. No headers can be sent early.
    return undefined as unknown as Socket;
  };
  const work = Promise.resolve()
    .then(async () => {
      options.authority.assertCurrent();
      await options.authority.beforeConnect?.();
      options.authority.assertCurrent();
      if (stopped || options.signal?.aborted)
        throw new ClientTransportError("CANCELLED_OR_TIMEOUT", false);
      endpoint.protocol = "ws:";
      endpoint.pathname = "/v1/events";
      ws = new WebSocket(endpoint, {
        agent,
        perMessageDeflate: false,
        maxPayload: caps.message,
        followRedirects: false,
        handshakeTimeout: 30000,
      });
      ws.on("error", (error) => stop(error));
      ws.once("close", () => {
        if (!stopped) stop(new ClientTransportError("API_UNAVAILABLE", sent));
        websocketResolve();
      });
      let decoding: Promise<void> = Promise.resolve();
      let pending = 0;
      ws.on("message", (data, binary) => {
        if (stopped) return;
        const size = Array.isArray(data)
          ? data.reduce((sum, part) => sum + part.length, 0)
          : data.byteLength;
        if (
          binary ||
          ++pending > caps.messages ||
          bytes + size > caps.bytes + (attached ? 0 : caps.message)
        ) {
          stop(new ClientTransportError("LIMIT", sent));
          return;
        }
        bytes += size;
        decoding = decoding.then(async () => {
          try {
            if (stopped) return;
            options.authority.assertCurrent();
            if (!socket || socket.destroyed) throw new Error("No connected session socket");
            await options.authority.afterResponse(socket);
            options.authority.assertCurrent();
            if (stopped) return;
            const raw = Buffer.isBuffer(data)
              ? data
              : Array.isArray(data)
                ? Buffer.concat(data)
                : Buffer.from(data);
            const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
            if (!attached) {
              if (!value || Object.keys(value).length !== 2 || value.type !== "attached")
                throw new Error("Invalid session attachment");
              const snapshot = parseOperationResult("ssh_session_attach", { data: value.data });
              if (
                snapshot.session.id !== sessionId ||
                Buffer.byteLength(snapshot.snapshot) > 1048576
              )
                throw new Error("Invalid session attachment");
              targetId = snapshot.session.targetId;
              attached = true;
              readyResolve(snapshot);
            } else {
              if (
                !value ||
                !["session.output", "session.state"].includes(value.type) ||
                value.id !== sessionId ||
                value.targetId !== targetId ||
                typeof value.targetId !== "string" ||
                !/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(value.targetId) ||
                Object.keys(value).some(
                  (key) => !["type", "id", "targetId", "sequence"].includes(key),
                ) ||
                (value.sequence !== undefined &&
                  (!Number.isSafeInteger(value.sequence) || value.sequence < 0))
              )
                throw new Error("Invalid session event");
              if (queue.length >= caps.messages || bytes > caps.bytes)
                throw new ClientTransportError("LIMIT", sent);
              queue.push({ event: Object.freeze(value) as ManagerEvent, bytes: size });
              notify?.();
              return;
            }
          } catch (error) {
            stop(
              error instanceof ClientTransportError
                ? error
                : new ClientTransportError("API_RESPONSE", sent),
            );
          } finally {
            pending--;
          }
          if (!stopped) bytes -= size;
        });
      });
      ws.once("open", () => {
        authWrite = new Promise<void>((resolve, reject) => {
          try {
            options.authority.assertCurrent();
            if (stopped) throw new ClientTransportError("CANCELLED_OR_TIMEOUT", sent);
            ws!.send(serializeClientJson({ token, sessionId }, 16384), (error) => {
              if (error) {
                stop(error);
                reject(error);
              } else resolve();
            });
          } catch (error) {
            stop(error as Error);
            reject(error);
          }
        });
        void authWrite.catch(() => {});
      });
      await websocketClosed;
      await decoding;
    })
    .catch((error) => {
      stop(error as Error);
      if (!ws) websocketResolve();
    });
  const settled = (async () => {
    await work;
    await proof;
    await authWrite.catch(() => {});
    await socketClosed;
    options.signal?.removeEventListener("abort", abort);
    agent.destroy();
  })();
  let reading = false;
  const events: AsyncIterable<ManagerEvent> = {
    [Symbol.asyncIterator]() {
      if (reading) throw new Error("Session events already have a consumer");
      reading = true;
      const iterator = (async function* () {
        try {
          while (!stopped) {
            const item = queue.shift();
            if (item) {
              bytes -= item.bytes;
              yield item.event;
              continue;
            }
            await new Promise<void>((resolve) => {
              notify = resolve;
            });
            notify = undefined;
          }
          if (failure) throw failure;
        } finally {
          stop();
          await settled;
        }
      })();
      return {
        next: () => iterator.next(),
        async return() {
          // Generator.return alone queues behind a pending next. Stop/wake first.
          stop();
          try {
            return await iterator.return();
          } finally {
            await settled;
          }
        },
        async throw(error: unknown) {
          stop();
          try {
            return await iterator.throw(error);
          } finally {
            await settled;
          }
        },
      };
    },
  };
  return Object.freeze({
    ready,
    events,
    settled,
    close() {
      stop();
      return settled;
    },
  });
}
