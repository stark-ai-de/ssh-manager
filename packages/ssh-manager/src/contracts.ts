import { z } from "zod";

export const identifier = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/);
export const endpoint = z
  .string()
  .min(1)
  .max(253)
  .regex(/^[a-zA-Z0-9_.:\[\]-]+$/);
export const port = z.number().int().min(1).max(65535);
export const capability = z.enum(["connect", "shell", "files.read", "files.write", "tunnel"]);
export const capabilities = capability.array().max(5);
export type Capability = z.infer<typeof capability>;
/** Actors are supplied by trusted embedding code or authenticated transports, never tool arguments. */
export type Actor = Readonly<{ id: string; kind: "operator" | "agent" }>;
export const proxySchema = z.strictObject({
  kind: z.enum(["socks5", "http-connect"]),
  host: endpoint,
  port,
  username: z.string().max(128).optional(),
  credentialId: identifier.optional(),
});
export const profileInput = z.strictObject({
  name: z.string().min(1).max(160),
  host: endpoint,
  port: port.default(22),
  username: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[^\x00-\x1f\x7f]+$/),
  credentialId: identifier.optional(),
  groups: identifier.array().max(32).default([]),
  shell: z.enum(["posix", "powershell", "cmd"]).default("posix"),
  jumpIds: identifier.array().max(4).default([]),
  proxy: proxySchema.optional(),
  fileRoots: z.string().min(1).max(1024).array().max(16).default(["/"]),
});
export type ProfileInput = z.input<typeof profileInput>;
export type Profile = z.infer<typeof profileInput> & { id: string; revision: number };
export const credentialInput = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("agent"),
    name: z.string().min(1).max(160),
    socket: z.string().min(1).max(2048),
  }),
  z.strictObject({
    kind: z.literal("key-file"),
    name: z.string().min(1).max(160),
    path: z.string().min(1).max(2048),
    passphraseId: identifier.optional(),
  }),
  z.strictObject({
    kind: z.literal("vault"),
    name: z.string().min(1).max(160),
    secretKind: z.enum(["password", "private-key", "passphrase"]),
    passphraseId: identifier.optional(),
  }),
]);
export type CredentialRef = { id: string; name: string; revision: number } & (
  | { kind: "agent"; socket: string }
  | { kind: "key-file"; path: string; passphraseId?: string }
  | { kind: "vault"; secretKind: "password" | "private-key" | "passphrase"; passphraseId?: string }
);
export type CredentialSecret = { value: string; passphrase?: string };
export type TrustPin = {
  profileId: string;
  revision: number;
  fingerprint: string;
  key: string;
  revoked: boolean;
};
export type ConnectionInfo = {
  id: string;
  targetId: string;
  state: "ready" | "closed";
  channels: number;
  createdAt: string;
};
export type ConnectionLimits = {
  connections: number;
  perTarget: number;
  channels: number;
  waiters: number;
  authTimeout: number;
  channelTimeout: number;
  idleTimeout: number;
};
export type SessionInfo = {
  id: string;
  targetId: string;
  state: "running" | "closed" | "lost" | "recoverable";
  cols: number;
  rows: number;
  tmux: boolean;
  recording: boolean;
  createdAt: string;
  writer?: string;
  reason?: string;
};
export type JobInfo = {
  id: string;
  targetId: string;
  state: "running" | "succeeded" | "failed" | "cancelled" | "unknown";
  createdAt: string;
  exitCode?: number;
  signal?: string;
};
export type TunnelInput = {
  kind: "local" | "remote" | "socks";
  listenPort: number;
  destinationHost?: string;
  destinationPort?: number;
  reconnect?: boolean;
};
export type TunnelInfo = TunnelInput & {
  id: string;
  targetId: string;
  state: "running" | "interrupted" | "closed" | "failed";
  reason?: string;
};
export type OutputPart = { sequence: number; text: string; stream: "stdout" | "stderr" };
export type OutputPage = { parts: OutputPart[]; cursor: number; gap: boolean };
export type AuditEvent = {
  sequence: number;
  time: string;
  actorId: string;
  targetId?: string;
  action: string;
  outcome: string;
};
export type ManagerEvent = {
  type: "session.output" | "session.state" | "job.state" | "tunnel.state";
  id: string;
  targetId: string;
  sequence?: number;
};

export class ManagementError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, string | number | boolean>,
  ) {
    super(message);
    this.name = "ManagementError";
  }
}
export function fault(
  code: string,
  message: string,
  details?: Record<string, string | number | boolean>,
): never {
  throw new ManagementError(code, message, details);
}
export function requireOperator(actor: Actor) {
  if (actor.kind !== "operator")
    fault("FORBIDDEN", "This action requires a locally authenticated operator.");
}
export function parse<T extends z.ZodType>(schema: T, input: unknown): z.output<T> {
  const result = schema.safeParse(input);
  if (!result.success) fault("INVALID_ARGUMENT", "Arguments do not match the operation contract.");
  return result.data;
}
