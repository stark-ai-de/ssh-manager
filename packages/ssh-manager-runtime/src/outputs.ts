import { z } from "zod";
import { profileInput, identifier, capabilities } from "@stark-ai/ssh-manager/contracts";
import type { Operation } from "./catalog.js";

const profile = profileInput.extend({ id: identifier, revision: z.number().int().positive() });
const connection = z.strictObject({
  id: identifier,
  targetId: identifier,
  state: z.enum(["ready", "closed"]),
  channels: z.number().int().nonnegative(),
  createdAt: z.string(),
});
const session = z.strictObject({
  id: identifier,
  targetId: identifier,
  state: z.enum(["running", "closed", "lost", "recoverable"]),
  cols: z.number().int(),
  rows: z.number().int(),
  tmux: z.boolean(),
  recording: z.boolean(),
  createdAt: z.string(),
  writer: z.string().optional(),
  reason: z.string().optional(),
});
const job = z.strictObject({
  id: identifier,
  targetId: identifier,
  state: z.enum(["running", "succeeded", "failed", "cancelled", "unknown"]),
  createdAt: z.string(),
  exitCode: z.number().nullable().optional(),
  signal: z.string().optional(),
});
const output = z.strictObject({
  parts: z.array(
    z.strictObject({
      sequence: z.number().int(),
      text: z.string(),
      stream: z.enum(["stdout", "stderr"]),
    }),
  ),
  cursor: z.number().int(),
  gap: z.boolean(),
});
const completed = z.strictObject({ completed: z.boolean() });
const grant = z.strictObject({
  targetId: identifier,
  revision: z.number().int().optional(),
  capabilities: capabilities.optional(),
});
const vault = z.strictObject({
  initialized: z.boolean(),
  locked: z.boolean(),
  recordCount: z.number().int(),
});
const credential = z.strictObject({
  id: identifier,
  name: z.string(),
  revision: z.number().int(),
  kind: z.enum(["agent", "key-file", "vault"]),
  secretKind: z.enum(["password", "private-key", "passphrase"]).optional(),
});
const stats = z.strictObject({
  size: z.number(),
  mode: z.number(),
  uid: z.number().optional(),
  gid: z.number().optional(),
  atime: z.number(),
  mtime: z.number(),
  directory: z.boolean(),
  file: z.boolean(),
  symlink: z.boolean(),
});
const tunnel = z.strictObject({
  id: identifier,
  targetId: identifier,
  kind: z.enum(["local", "remote", "socks"]),
  listenPort: z.number().int(),
  destinationHost: z.string().optional(),
  destinationPort: z.number().int().optional(),
  reconnect: z.boolean().optional(),
  state: z.enum(["running", "interrupted", "closed", "failed"]),
  reason: z.string().optional(),
});
const jobRead = z.strictObject({ job, output, remoteTerminationConfirmed: z.boolean() });
const trust = z.strictObject({ targetId: identifier, fingerprint: z.string() });
/** Public wire result contracts, independent of MCP response formatting. */
export const outputs = {
  ssh_hosts_list: profile.array(),
  ssh_host_create: profile,
  ssh_host_update: profile,
  ssh_host_remove: completed,
  ssh_hosts_export: z.strictObject({ schema: z.literal(1), profiles: profile.array() }),
  ssh_import_preview: z.strictObject({
    profiles: z.array(
      z.strictObject({
        name: z.string(),
        host: z.string(),
        username: z.string(),
        port: z.number(),
      }),
    ),
    warnings: z.array(z.strictObject({ line: z.number().int(), directive: z.string() })),
  }),
  ssh_import_apply: profile.array(),
  ssh_grants_get: grant,
  ssh_grants_set: grant,
  ssh_credentials_list: credential.array(),
  ssh_credential_add: credential,
  ssh_credential_update: credential,
  ssh_credential_remove: completed,
  ssh_vault_status: vault,
  ssh_vault_initialize: vault,
  ssh_vault_unlock: vault,
  ssh_vault_lock: vault,
  ssh_vault_rotate: vault,
  ssh_vault_restore: vault,
  ssh_vault_backup: z.object({
    schema: z.literal(1),
    kdf: z.object({
      algorithm: z.literal("argon2id"),
      memory: z.number(),
      passes: z.number(),
      parallelism: z.number(),
      salt: z.string(),
    }),
    wrappedKey: z.object({ nonce: z.string(), ciphertext: z.string(), tag: z.string() }),
    records: z.record(
      z.string(),
      z.object({ nonce: z.string(), ciphertext: z.string(), tag: z.string() }),
    ),
  }),
  ssh_host_inspect: trust.extend({ revision: z.number().int(), key: z.string() }),
  ssh_host_confirm: trust,
  ssh_host_revoke: completed,
  ssh_connections_list: connection.array(),
  ssh_connection_open: connection,
  ssh_connection_probe: connection,
  ssh_connection_close: completed,
  ssh_connection_reconnect: connection,
  ssh_sessions_list: session.array(),
  ssh_session_create: session,
  ssh_session_attach: z.strictObject({
    session,
    snapshot: z.string(),
    cursor: z.number().int(),
    output,
    recordingPaused: z.boolean(),
  }),
  ssh_session_read: z.strictObject({ session, output }),
  ssh_session_detach: session,
  ssh_session_writer: session,
  ssh_session_input: z.strictObject({ accepted: z.number().int() }),
  ssh_session_resize: session,
  ssh_session_close: session,
  ssh_session_recover: session,
  ssh_session_recording: z.strictObject({ text: z.string() }),
  ssh_jobs_list: job.array(),
  ssh_job_start: job,
  ssh_job_read: jobRead,
  ssh_job_cancel: job.extend({ remoteTerminationConfirmed: z.boolean() }),
  ssh_group_run: z.array(
    z.strictObject({
      targetId: identifier,
      job: job.optional(),
      error: z.strictObject({ code: z.string(), message: z.string() }).optional(),
    }),
  ),
  ssh_files_list: stats.extend({ name: z.string() }).array(),
  ssh_file_stat: stats,
  ssh_file_read: z.strictObject({
    data: z.string(),
    encoding: z.literal("base64"),
    offset: z.number(),
    bytes: z.number(),
  }),
  ssh_file_write: completed,
  ssh_directory_create: completed,
  ssh_file_rename: completed,
  ssh_file_remove: completed,
  ssh_file_chmod: completed,
  ssh_tunnels_list: tunnel.array(),
  ssh_tunnel_create: tunnel,
  ssh_tunnel_close: tunnel,
  ssh_tunnel_reconnect: tunnel,
  ssh_audit_read: z.strictObject({
    events: z.array(
      z.strictObject({
        sequence: z.number().int(),
        time: z.string(),
        actorId: z.string(),
        targetId: identifier.optional(),
        action: z.string(),
        outcome: z.string(),
      }),
    ),
    cursor: z.number().int(),
    gap: z.boolean(),
  }),
  ssh_diagnose: z.strictObject({
    targetId: identifier,
    revision: z.number().int(),
    grants: grant,
    vault,
    connections: connection.array(),
    features: z.strictObject({
      tmux: z.boolean(),
      shell: z.enum(["posix", "powershell", "cmd"]),
      routeHops: z.number().int(),
    }),
    limits: z.record(z.string(), z.number()),
  }),
} satisfies Record<Operation, z.ZodType>;
/** Wire inputs may be wider than canonical handler results; preserve those accepted meanings. */
export type OperationResultInputs = { [K in Operation]: z.input<(typeof outputs)[K]> };
export type OperationResults = { [K in Operation]: z.output<(typeof outputs)[K]> };
export function resultSchema(operation: Operation) {
  return z.strictObject({ data: outputs[operation] });
}
/** Validate the wire envelope before exposing data with its operation-specific type. */
export function parseOperationResult<K extends Operation>(
  operation: K,
  response: unknown,
): OperationResults[K] {
  // Selection by the same operation key establishes this correlation; no schema is widened.
  return resultSchema(operation).parse(response).data as OperationResults[K];
}
