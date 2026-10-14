import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ManagementClient, APIError } from "../dist/client.js";
import { catalog, parseOperationResult, resultSchema } from "../dist/catalog.js";
import { outputs } from "../dist/outputs.js";

const execute = promisify(execFile);
const directory = fileURLToPath(new URL("../", import.meta.url));
const job = {
  id: "fixture-job",
  targetId: "fixture-target",
  state: "running",
  createdAt: "2026-01-01T00:00:00.000Z",
};
const args = { targetId: job.targetId, command: "fixture command" };

async function replyClient(t, reply) {
  const requests = [];
  let client;
  const server = http.createServer((request, response) => {
    request.resume();
    let result;
    if (request.url === "/v1/clients")
      result = {
        body: {
          data: {
            token: "t".repeat(43),
            actor: { id: "fixture-actor", kind: "agent" },
            expiresInMs: 120000,
          },
        },
      };
    else if (request.url === "/v1/clients/detach") result = { body: { data: { detached: true } } };
    else {
      requests.push(request.url);
      result = reply(request.url, requests.length - 1);
    }
    response.writeHead(result.status ?? 200, { "content-type": "application/json" });
    response.end(result.raw ?? JSON.stringify(result.body));
  });
  t.after(async () => {
    try {
      await client?.close();
    } finally {
      await new Promise((resolve, reject) =>
        server.close((error) =>
          error && error.code !== "ERR_SERVER_NOT_RUNNING" ? reject(error) : resolve(),
        ),
      );
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  client = new ManagementClient(`http://127.0.0.1:${server.address().port}`, "fixture-bootstrap");
  await client.connect();
  return { client, requests };
}

test("operation result ownership covers the catalog and preserves accepted nullable/optional meanings", async (t) => {
  assert.deepEqual(Object.keys(outputs).sort(), Object.keys(catalog).sort());
  const output = { parts: [], cursor: 0, gap: false };
  const stats = {
    size: 0,
    mode: 0,
    atime: 0,
    mtime: 0,
    directory: false,
    file: true,
    symlink: false,
  };
  const cases = [
    ["ssh_job_start", job],
    ["ssh_job_start", { ...job, exitCode: null }],
    ["ssh_job_start", { ...job, exitCode: 0 }],
    [
      "ssh_job_read",
      { job: { ...job, exitCode: null }, output, remoteTerminationConfirmed: false },
    ],
    ["ssh_job_cancel", { ...job, exitCode: null, remoteTerminationConfirmed: false }],
    ["ssh_jobs_list", [job, { ...job, exitCode: null }]],
    ["ssh_group_run", [{ targetId: job.targetId, job: { ...job, exitCode: null } }]],
    [
      "ssh_group_run",
      [{ targetId: job.targetId, error: { code: "FIXTURE", message: "fixture failure" } }],
    ],
    ["ssh_file_stat", stats],
    ["ssh_file_stat", { ...stats, uid: 0, gid: 0 }],
    [
      "ssh_host_create",
      {
        id: "fixture-profile",
        revision: 1,
        name: "fixture",
        host: "fixture.invalid",
        username: "fixture",
      },
    ],
  ];
  const { client, requests } = await replyClient(t, (_route, index) => ({
    body: { data: cases[index][1] },
  }));
  for (const [operation, data] of cases) {
    const envelope = { data };
    const original = structuredClone(envelope);
    const expected = resultSchema(operation).parse(envelope).data;
    assert.deepEqual(parseOperationResult(operation, envelope), expected);
    assert.deepEqual(await client.call(operation, args), expected);
    assert.deepEqual(envelope, original, "validation must not mutate its input");
  }
  assert.equal(requests.length, cases.length);
  assert.equal(
    Object.hasOwn(parseOperationResult("ssh_job_start", { data: job }), "exitCode"),
    false,
  );
  assert.equal(
    parseOperationResult("ssh_job_start", { data: { ...job, exitCode: null } }).exitCode,
    null,
  );
});

test("malformed successful operation replies fail sanitized and are never replayed", async (t) => {
  const marker = "fixture-private-response-value";
  const replies = [
    { body: null },
    { body: {} },
    { body: { data: null } },
    { body: { data: [] } },
    { body: { data: { ...job, state: marker } } },
    { body: { data: { ...job, exitCode: marker } } },
    { body: { data: { ...job, extra: marker } } },
    { body: { data: job, extra: marker } },
    { body: { data: { ...job, id: 42 } } },
    { raw: "{invalid-json" },
  ];
  const { client, requests } = await replyClient(t, (_route, index) => replies[index]);
  for (const reply of replies) {
    if (reply.body !== undefined)
      assert.throws(() => parseOperationResult("ssh_job_start", reply.body));
    await assert.rejects(client.call("ssh_job_start", args), (error) => {
      assert.ok(error instanceof APIError);
      assert.equal(error.code, "API_RESPONSE");
      assert.equal(error.details, undefined);
      assert.doesNotMatch(error.message + error.stack, new RegExp(marker));
      assert.doesNotMatch(error.message, /Zod|exitCode|state|extra/);
      return true;
    });
  }
  assert.equal(
    requests.length,
    replies.length,
    "each call must send exactly one operation request",
  );
});

test("server errors, registration requirements and caller cancellation keep their existing meaning", async (t) => {
  const { client, requests } = await replyClient(t, () => ({
    status: 403,
    body: {
      error: { code: "FORBIDDEN", message: "fixture denial", details: { capability: "shell" } },
    },
  }));
  await assert.rejects(client.call("ssh_job_start", args), {
    name: "APIError",
    code: "FORBIDDEN",
    message: "fixture denial",
    details: { capability: "shell" },
  });
  assert.equal(requests.length, 1);
  await assert.rejects(client.call("ssh_job_start", args, { signal: AbortSignal.abort() }), {
    code: "CANCELLED_OR_TIMEOUT",
  });
  assert.equal(requests.length, 1);
  const disconnected = new ManagementClient(client.url, "fixture-bootstrap");
  await assert.rejects(disconnected.call("ssh_job_start", args), { code: "NOT_CONNECTED" });
  assert.equal(requests.length, 1);
});

test("invalid endpoints are rejected without reflecting their input", () => {
  for (const endpoint of [
    "fixture-private-endpoint",
    "https://127.0.0.1",
    "http://fixture.invalid",
    "http://user:secret@127.0.0.1",
  ]) {
    assert.throws(
      () => new ManagementClient(endpoint, "fixture-bootstrap"),
      (error) => {
        assert.ok(error instanceof APIError);
        assert.equal(error.code, "INVALID_ENDPOINT");
        assert.equal(error.details, undefined);
        assert.ok(!error.message.includes(endpoint));
        return true;
      },
    );
  }
});

test("client declarations follow wire results and incompatible handlers fail type checking", async (t) => {
  const temporary = fs.mkdtempSync(path.join(directory, ".result-types-"));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(temporary, "proof.mts"),
    `
import type { z } from "zod";
import type { JobInfo } from "@stark-ai/ssh-manager/contracts";
import type { Operation, OperationInputs, OperationResults } from "../dist/catalog.js";
import type { ManagementClient, OperationResults as ClientResults } from "../dist/client.js";
import type { outputs, parseOperationResult, OperationResultInputs } from "../dist/outputs.js";
import type { handlers, OperationHandlers } from "../dist/handlers.js";
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;
type SchemaResults = { [K in Operation]: z.output<(typeof outputs)[K]> };
declare const client: ManagementClient;
type ClientCallResults = { [K in Operation]: Awaited<ReturnType<typeof client.call<K>>> };
type ParsedResults = { [K in Operation]: ReturnType<typeof parseOperationResult<K>> };
type HandlerResults = { [K in Operation]: Awaited<ReturnType<ReturnType<typeof handlers>[K]>> };
type Incompatible = { [K in Operation]: HandlerResults[K] extends OperationResultInputs[K] ? never : K }[Operation];
type SchemaAgreement = Assert<Equal<OperationResults, SchemaResults>>;
type ClientAliasAgreement = Assert<Equal<OperationResults, ClientResults>>;
type ClientCallAgreement = Assert<Equal<OperationResults, ClientCallResults>>;
type ParserAgreement = Assert<Equal<OperationResults, ParsedResults>>;
type HandlerAgreement = Assert<Equal<Incompatible, never>>;
type NullableExit = Assert<Equal<OperationResults["ssh_job_start"]["exitCode"], number | null | undefined>>;
const jobReply = client.call("ssh_job_start", { targetId: "fixture-target", command: "fixture" });
type JobCallAgreement = Assert<Equal<Awaited<typeof jobReply>, OperationResults["ssh_job_start"]>>;
declare const wireJob: OperationResults["ssh_job_start"];
// @ts-expect-error wire acceptance is intentionally wider than canonical job declarations
const narrowed: JobInfo = wireJob;
declare const canonicalJob: JobInfo;
const compatible: OperationResultInputs["ssh_job_start"] = canonicalJob;
const nullable: OperationResultInputs["ssh_job_start"] = { ...canonicalJob, exitCode: null };
declare const current: ReturnType<typeof handlers>;
const incompatibleJob = { ...current, ssh_job_start: (_a: OperationInputs["ssh_job_start"]) => ({ ...canonicalJob, exitCode: "invalid" }) };
// @ts-expect-error incompatible synchronous handler result must not be accepted
incompatibleJob satisfies OperationHandlers;
const incompatibleAsyncJob = { ...current, ssh_job_start: async (_a: OperationInputs["ssh_job_start"]) => ({ ...canonicalJob, exitCode: "invalid" }) };
// @ts-expect-error incompatible asynchronous handler result must not be accepted
incompatibleAsyncJob satisfies OperationHandlers;
const incompatibleSession = { ...current, ssh_session_create: (_a: OperationInputs["ssh_session_create"]) => canonicalJob };
// @ts-expect-error another operation's result must not be accepted for a session
incompatibleSession satisfies OperationHandlers;
`,
  );
  fs.writeFileSync(
    path.join(temporary, "tsconfig.json"),
    JSON.stringify({
      extends: "../tsconfig.json",
      compilerOptions: { noEmit: true, rootDir: "." },
      include: ["proof.mts"],
    }),
  );
  await execute(
    process.execPath,
    [
      path.join(directory, "node_modules/typescript/lib/tsc.js"),
      "-p",
      path.join(temporary, "tsconfig.json"),
    ],
    { timeout: 30000 },
  );
});
