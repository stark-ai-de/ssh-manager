import fs from "node:fs";
import path from "node:path";
import { randomBytes, createHash } from "node:crypto";
import { Readable } from "node:stream";
import Fastify, { type FastifyRequest } from "fastify";
import websocket from "@fastify/websocket";
import { z } from "zod";
import {
  SSHManager,
  ManagementError,
  type Actor,
  type ManagerOptions,
  type ManagerEvent,
} from "@stark-ai/ssh-manager";
import { catalog, type Operation } from "./catalog.js";
import { handlers } from "./handlers.js";
import { resultSchema } from "./outputs.js";

type Registration = { actor: Actor; expires: number };
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
function localToken(file: string) {
  if (!fs.existsSync(file))
    fs.writeFileSync(file, randomBytes(32).toString("base64url"), { flag: "wx", mode: 0o600 });
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 100)
    throw new ManagementError("UNSAFE_STATE", "Invalid local authentication file.");
  if (process.platform !== "win32") fs.chmodSync(file, 0o600);
  const value = fs.readFileSync(file, "utf8").trim();
  if (value.length < 40)
    throw new ManagementError("UNSAFE_STATE", "Local authentication token is invalid.");
  return value;
}
export async function createRuntime(
  options: ManagerOptions & {
    port?: number;
    viewerDirectory?: string;
    assets?: Record<string, string>;
    clientTtlMs?: number;
    onClose?: () => void | Promise<void>;
  },
) {
  const manager = new SSHManager(options);
  const app = Fastify({
    logger: false,
    bodyLimit: 1024 * 1024,
    requestTimeout: 30000,
    connectionTimeout: 30000,
    ajv: { customOptions: { removeAdditional: false } },
  });
  const clients = new Map<string, Registration>();
  const ttl = options.clientTtlMs ?? 120000;
  app.server.maxConnections = 256;
  let activeViewers = 0;
  let expiry: ReturnType<typeof setInterval> | undefined;
  app.addHook("onClose", async () => {
    clearInterval(expiry);
    manager.shutdown();
    await options.onClose?.();
  });
  try {
    const agentToken = localToken(path.join(options.stateDirectory, "agent.token"));
    const operatorToken = localToken(path.join(options.stateDirectory, "operator.token"));
    const bootstraps = new Map([
      [hash(agentToken), "agent" as const],
      [hash(operatorToken), "operator" as const],
    ]);
    let origin = "";
    const extract = (authorization?: string) =>
      authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
    const authenticate = (token: string): Actor => {
      const registration = clients.get(hash(token));
      if (!registration || registration.expires <= Date.now())
        throw new ManagementError("UNAUTHENTICATED", "Register an authenticated local API client.");
      registration.expires = Date.now() + ttl;
      return registration.actor;
    };
    const actor = (req: FastifyRequest) => authenticate(extract(req.headers.authorization));
    expiry = setInterval(
      () => {
        for (const [token, registration] of clients)
          if (registration.expires <= Date.now()) {
            manager.detachActor(registration.actor.id);
            clients.delete(token);
          }
      },
      Math.min(30000, ttl),
    );
    expiry.unref();
    app.setErrorHandler((error, _req, reply) => {
      const e =
        error instanceof ManagementError
          ? error
          : new ManagementError(
              (error as any).validation ? "INVALID_ARGUMENT" : "INTERNAL",
              "Request could not be completed.",
            );
      const status =
        e.code === "UNAUTHENTICATED"
          ? 401
          : e.code === "FORBIDDEN" || e.code === "PATH_DENIED"
            ? 403
            : e.code === "NOT_FOUND"
              ? 404
              : e.code === "CONFLICT"
                ? 409
                : e.code === "INTERNAL"
                  ? 500
                  : 400;
      reply.code(status).send({
        error: { code: e.code, message: e.message, ...(e.details ? { details: e.details } : {}) },
      });
    });
    app.addHook("onRequest", async (req, reply) => {
      const host = req.headers.host;
      const expected = new URL(origin).host;
      if (host !== expected || (req.headers.origin && req.headers.origin !== origin))
        throw new ManagementError(
          "FORBIDDEN",
          "Management API Host or Origin is not the authenticated loopback origin.",
        );
      reply
        .header("cache-control", "no-store")
        .header("x-content-type-options", "nosniff")
        .header("referrer-policy", "no-referrer");
      const route = req.url.split("?")[0];
      if (route?.startsWith("/v1/") && route !== "/v1/clients" && route !== "/v1/events")
        actor(req);
    });
    await app.register(websocket, { options: { maxPayload: 32768 } });
    app.post(
      "/v1/clients",
      { schema: { body: { type: "object", additionalProperties: false, properties: {} } } },
      async (req) => {
        const role = bootstraps.get(hash(extract(req.headers.authorization)));
        if (!role)
          throw new ManagementError(
            "UNAUTHENTICATED",
            "Use the local agent or operator bootstrap token.",
          );
        if (clients.size >= 128)
          throw new ManagementError("LIMIT", "Authenticated client limit reached.");
        const token = randomBytes(32).toString("base64url");
        const identity: Actor = { id: randomBytes(16).toString("hex"), kind: role };
        clients.set(hash(token), { actor: identity, expires: Date.now() + ttl });
        return { data: { token, actor: identity, expiresInMs: ttl } };
      },
    );
    app.post("/v1/clients/heartbeat", async (req) => ({ data: { alive: !!actor(req) } }));
    app.post("/v1/clients/detach", async (req) => {
      const identity = actor(req);
      manager.detachActor(identity.id);
      clients.delete(hash(extract(req.headers.authorization)));
      return { data: { detached: true } };
    });
    const paths: Record<string, unknown> = {};
    for (const [name, definition] of Object.entries(catalog)) {
      const schema = z.toJSONSchema(definition.schema, { target: "draft-7" });
      delete schema.$schema;
      const wireOutput = resultSchema(name as Operation);
      const responseSchema = z.toJSONSchema(wireOutput, { target: "draft-7" });
      delete responseSchema.$schema;
      paths[`/v1/${name}`] = {
        post: {
          operationId: name,
          description: definition.description,
          security: [{ bearerAuth: [] }],
          "x-operator-required": definition.operator,
          requestBody: { required: true, content: { "application/json": { schema } } },
          responses: {
            "200": {
              description: "Typed operation result",
              content: { "application/json": { schema: responseSchema } },
            },
            "400": { description: "Domain or validation error" },
            "403": { description: "Capability or operator access denied" },
          },
        },
      };
      app.post(
        `/v1/${name}`,
        {
          schema: { body: schema as any },
          // Ciphertext can exceed a megabyte even for a single valid credential.
          // Authorize setup before parsing its separately bounded larger payloads.
          ...(definition.operator
            ? {
                bodyLimit: (name === "ssh_vault_restore" ? 48 : 16) * 1024 * 1024,
                onRequest: async (req: FastifyRequest) => {
                  if (actor(req).kind !== "operator")
                    throw new ManagementError(
                      "FORBIDDEN",
                      "Only a local operator can perform setup.",
                    );
                },
              }
            : {}),
        },
        async (req, reply) => {
          const identity = actor(req);
          if (definition.operator && identity.kind !== "operator")
            throw new ManagementError(
              "FORBIDDEN",
              "This setup operation requires the locally authenticated operator.",
            );
          const controller = new AbortController();
          const cancel = () => {
            if (!reply.raw.writableFinished) controller.abort();
          };
          req.raw.once("aborted", cancel);
          reply.raw.once("close", cancel);
          try {
            const handler = handlers(manager, identity, controller.signal)[name as Operation] as (
              args: any,
            ) => unknown;
            return wireOutput.parse({ data: await handler(definition.schema.parse(req.body)) });
          } finally {
            req.raw.off("aborted", cancel);
            reply.raw.off("close", cancel);
          }
        },
      );
    }
    const jsonResponse = (schema: unknown) => ({
      "200": {
        description: "Successful authenticated response",
        content: { "application/json": { schema } },
      },
      "401": { description: "Authentication required" },
      "403": { description: "Access denied" },
    });
    const emptyBody = {
      required: true,
      content: { "application/json": { schema: { type: "object", additionalProperties: false } } },
    };
    paths["/v1/clients"] = {
      post: {
        operationId: "registerClient",
        description:
          "Exchange the private local agent/operator bootstrap token for an expiring client token; role is derived from the bootstrap.",
        security: [{ bearerAuth: [] }],
        requestBody: emptyBody,
        responses: jsonResponse({
          type: "object",
          properties: {
            data: {
              type: "object",
              required: ["token", "actor", "expiresInMs"],
              properties: {
                token: { type: "string" },
                actor: {
                  type: "object",
                  properties: { id: { type: "string" }, kind: { enum: ["agent", "operator"] } },
                },
                expiresInMs: { type: "integer" },
              },
            },
          },
        }),
      },
    };
    for (const [route, operationId, field] of [
      ["heartbeat", "heartbeatClient", "alive"],
      ["detach", "detachClient", "detached"],
      ["runtime/stop", "stopRuntime", "stopping"],
    ]) {
      paths[route === "runtime/stop" ? "/v1/runtime/stop" : `/v1/clients/${route}`] = {
        post: {
          operationId,
          security: [{ bearerAuth: [] }],
          ...(route === "runtime/stop" ? { "x-operator-required": true } : {}),
          requestBody: emptyBody,
          responses: jsonResponse({
            type: "object",
            properties: { data: { type: "object", properties: { [field!]: { type: "boolean" } } } },
          }),
        },
      };
    }
    const fileParameters = ["targetId", "path"].map((name) => ({
      name,
      in: "query",
      required: true,
      schema: { type: "string" },
    }));
    const binary = { "application/octet-stream": { schema: { type: "string", format: "binary" } } };
    paths["/v1/files/download"] = {
      get: {
        operationId: "downloadFile",
        description:
          "Stream an authorized bounded SFTP file. Cancelling the response cancels the transfer.",
        security: [{ bearerAuth: [] }],
        parameters: fileParameters,
        responses: {
          "200": { description: "File bytes", content: binary },
          "403": { description: "Target or path denied" },
        },
      },
    };
    paths["/v1/files/upload"] = {
      put: {
        operationId: "uploadFile",
        description:
          "Stream an authorized SFTP upload. Interrupted uploads can leave a partial remote file.",
        security: [{ bearerAuth: [] }],
        parameters: fileParameters,
        requestBody: { required: true, content: binary },
        responses: jsonResponse({
          type: "object",
          properties: { data: { type: "object", properties: { completed: { type: "boolean" } } } },
        }),
      },
    };
    paths["/v1/events"] = {
      get: {
        operationId: "terminalEvents",
        description:
          "WebSocket upgrade. First message: {token, sessionId}; subsequent individual messages: writer, input or resize. Responses include attached snapshot/cursor, sequenced output notifications, accepted results and errors. Each message rechecks authenticated target authority.",
        "x-websocket": true,
        responses: {
          "101": { description: "WebSocket connection; authenticate within three seconds" },
        },
      },
    };
    app.get("/v1/openapi.json", async () => ({
      openapi: "3.1.0",
      info: { title: "Local SSH Management API", version: "1.0.0" },
      servers: [{ url: origin }],
      paths,
      components: { securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } } },
    }));
    app.get("/v1/files/download", async (req, reply) => {
      const query = z.strictObject({ targetId: z.string(), path: z.string() }).parse(req.query);
      const controller = new AbortController();
      reply.raw.once("close", () => {
        if (!reply.raw.writableFinished) controller.abort();
      });
      const stream = await manager.files.download(actor(req), query.targetId, query.path, {
        signal: controller.signal,
      });
      reply.type("application/octet-stream").header("content-disposition", "attachment");
      return reply.send(stream);
    });
    app.addContentTypeParser("application/octet-stream", (_req, payload, done) =>
      done(null, payload),
    );
    app.put("/v1/files/upload", async (req) => {
      const query = z.strictObject({ targetId: z.string(), path: z.string() }).parse(req.query);
      const controller = new AbortController();
      req.raw.once("aborted", () => controller.abort());
      return {
        data: await manager.files.upload(
          actor(req),
          query.targetId,
          query.path,
          req.body as Readable,
          { signal: controller.signal },
        ),
      };
    });
    app.get("/v1/events", { websocket: true }, (socket, req) => {
      if (activeViewers >= 128) {
        socket.close(1013, "Viewer limit reached");
        return;
      }
      activeViewers++;
      let identity: Actor | undefined, sessionId: string | undefined;
      let closed = false,
        queued = 0,
        messages = Promise.resolve();
      const authTimeout = setTimeout(() => socket.close(1008, "Authenticate first"), 3000);
      const send = (data: unknown) => {
        if (closed || socket.readyState !== 1) return;
        if (socket.bufferedAmount > 65536) socket.close(1013, "Resync using session attach");
        else socket.send(JSON.stringify(data));
      };
      const event = (e: ManagerEvent) => {
        if (!identity || !sessionId || e.id !== sessionId) return;
        try {
          authenticate(token);
          manager.sessions.read(identity, sessionId);
          send(e);
        } catch {
          socket.close(1008, "Session authority changed");
        }
      };
      let token = "";
      socket.on("message", (message) => {
        if (closed) return;
        if (++queued > 16) {
          queued--;
          socket.close(1013, "Message queue limit reached");
          return;
        }
        messages = messages
          .then(async () => {
            if (closed) return;
            const body = JSON.parse(message.toString());
            if (!identity) {
              const auth = z
                .strictObject({ token: z.string().max(100), sessionId: z.string().max(80) })
                .parse(body);
              token = auth.token;
              identity = authenticate(token);
              sessionId = auth.sessionId;
              const snapshot = await manager.sessions.attach(identity, sessionId);
              if (closed) {
                manager.sessions.detach(identity, sessionId);
                return;
              }
              clearTimeout(authTimeout);
              manager.on("event", event);
              send({ type: "attached", data: snapshot });
            } else {
              authenticate(token);
              const action = z
                .discriminatedUnion("type", [
                  z.strictObject({ type: z.literal("input"), data: z.string().max(16384) }),
                  z.strictObject({ type: z.literal("resize"), cols: z.number(), rows: z.number() }),
                  z.strictObject({ type: z.literal("writer") }),
                ])
                .parse(body);
              const result =
                action.type === "input"
                  ? manager.sessions.input(identity, sessionId!, action.data)
                  : action.type === "resize"
                    ? manager.sessions.resize(identity, sessionId!, action.cols, action.rows)
                    : manager.sessions.writer(identity, sessionId!);
              send({ type: "accepted", data: result });
            }
          })
          .catch((error) => {
            const e =
              error instanceof ManagementError
                ? error
                : new ManagementError("INVALID_ARGUMENT", "Invalid terminal message.");
            send({ type: "error", error: { code: e.code, message: e.message } });
            if (!identity) socket.close(1008, "Authentication failed");
          })
          .finally(() => {
            queued--;
          });
      });
      socket.on("error", () => {});
      socket.once("close", () => {
        closed = true;
        activeViewers--;
        clearTimeout(authTimeout);
        manager.off("event", event);
        if (identity && sessionId) {
          try {
            manager.sessions.detach(identity, sessionId);
          } catch {
            manager.detachActor(identity.id);
          }
        }
      });
    });
    app.post("/v1/runtime/stop", async (req) => {
      if (actor(req).kind !== "operator")
        throw new ManagementError("FORBIDDEN", "Only a local operator can stop the daemon.");
      setTimeout(() => {
        void app.close();
      }, 50).unref();
      return { data: { stopping: true } };
    });
    if (options.viewerDirectory) {
      const viewerDir = options.viewerDirectory;
      const content = {
        "/": ["index.html", "text/html"],
        "/viewer.js": ["viewer.js", "text/javascript"],
        "/viewer.css": ["viewer.css", "text/css"],
      } as const;
      for (const [route, [file, mime]] of Object.entries(content))
        app.get(route, async (_req, reply) => {
          reply.header(
            "content-security-policy",
            // xterm generates theme/geometry styles. Scripts remain static and same-origin;
            // terminal output is rendered through xterm, never inserted as HTML.
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'",
          );
          return reply.type(mime).send(fs.readFileSync(path.join(viewerDir, file)));
        });
      for (const [route, file] of Object.entries(options.assets ?? {}))
        app.get(route, async (_req, reply) =>
          reply
            .type(route.endsWith(".css") ? "text/css" : "text/javascript")
            .send(fs.readFileSync(file)),
        );
    }
    origin = await app.listen({ host: "127.0.0.1", port: options.port ?? 0 });
    return { app, manager, url: origin, agentToken, operatorToken, close: () => app.close() };
  } catch (error) {
    await app.close().catch(() => {});
    manager.shutdown();
    throw error;
  }
}
