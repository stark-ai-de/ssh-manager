import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { generateKeyPairSync, createHash } from "node:crypto";
import ssh2 from "ssh2";
const { Server, utils } = ssh2;
import { SSHManager } from "../dist/index.js";

export const operator = { id: "local-operator", kind: "operator" };
export const agent = { id: "agent-one", kind: "agent" };
export const second = { id: "agent-two", kind: "agent" };
export const password = "ephemeral-test-password";
export const vaultPassword = "ephemeral-vault-password";
export const allCapabilities = ["connect", "shell", "files.read", "files.write", "tunnel"];
export const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export function profileInput(profile) {
  const { id: _id, revision: _revision, ...input } = profile;
  return input;
}
export async function until(check, timeout = 4000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await delay(15);
  }
  throw new Error("Fixture condition timed out");
}

// Private lifetime mechanics: callers exercise ownership through fixture interfaces.
function onceAsync(action) {
  let closing;
  return () => (closing ??= Promise.resolve().then(action));
}
function cleanupSync(steps) {
  const errors = [];
  for (const step of steps) {
    try {
      step();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length) throw new AggregateError(errors, "SSH fixture cleanup failed.");
}
async function cleanupAsync(steps) {
  const errors = [];
  for (const step of steps) {
    try {
      await step();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length) throw new AggregateError(errors, "SSH fixture cleanup failed.");
}
async function rollback(error, close) {
  try {
    await close();
  } catch (cleanupError) {
    throw new AggregateError([error, cleanupError], "SSH fixture setup and rollback failed.");
  }
  throw error;
}
function closeServer(server) {
  if (!server) return;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("SSH fixture server close timed out.")),
      4000,
    );
    try {
      server.close((error) => {
        clearTimeout(timeout);
        if (error && error.code !== "ERR_SERVER_NOT_RUNNING") reject(error);
        else resolve();
      });
    } catch (error) {
      clearTimeout(timeout);
      reject(error);
    }
  });
}

export async function sshFixture(options = {}) {
  const temporary = fs.mkdtempSync(
    path.join(options.temporaryRoot ?? os.tmpdir(), "ssh-counterpart-"),
  );
  let directory = temporary,
    server;
  const connections = new Set(),
    shells = new Set(),
    forwards = new Set(),
    tmux = new Map(),
    counts = { auth: 0, exec: 0, shell: 0 };
  const close = onceAsync(() =>
    cleanupAsync([
      ...[...connections].flatMap((client) => [
        () => client.end(),
        // Preserve forced nested-transport cleanup even if graceful end fails.
        () => client._sock.destroy(),
      ]),
      ...[...forwards].map((listener) => () => closeServer(listener)),
      () => closeServer(server),
      () => fs.rmSync(directory, { recursive: true, force: true }),
    ]),
  );
  try {
    directory = fs.realpathSync(temporary);
    const key = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({
      format: "pem",
      type: "pkcs1",
    });
    const publicKey = utils.parseKey(key).getPublicSSH();
    const fingerprint =
      "SHA256:" + createHash("sha256").update(publicKey).digest("base64").replace(/=+$/, "");
    fs.mkdirSync(path.join(directory, "allowed"));
    fs.writeFileSync(path.join(directory, "allowed", "hello.txt"), "hello fixture\n");
    const remote = (value) => {
      const normalized = path.posix.normalize(value);
      if (!normalized.startsWith("/")) throw new Error();
      return path.join(directory, normalized);
    };
    server = new Server({ hostKeys: [key] }, (client) => {
      connections.add(client);
      client.on("error", () => {});
      client.once("close", () => connections.delete(client));
      client.on("authentication", (context) => {
        counts.auth++;
        const accept = () =>
          context.method === "password" && context.password === password
            ? context.accept()
            : context.reject();
        options.authDelay ? setTimeout(accept, options.authDelay) : accept();
      });
      client.on("ready", () => {
        client.on("session", (accept, reject) => {
          if (options.denyChannels) {
            reject();
            return;
          }
          const session = accept();
          session.on("pty", (accept) => accept());
          session.on("window-change", (accept) => accept?.());
          session.on("shell", (accept) => {
            if (options.hangShell) return;
            counts.shell++;
            const channel = accept();
            shells.add(channel);
            channel.on("error", () => {});
            channel.write("\u001b[2J\u001b[Hfixture ready\r\n");
            channel.on("data", (data) => channel.write(data));
            channel.once("close", () => shells.delete(channel));
          });
          session.on("exec", (accept, _reject, info) => {
            counts.exec++;
            const channel = accept();
            channel.on("error", () => {});
            if (options.tmux && info.command.startsWith("tmux ")) {
              const [, operation, , name] = info.command.split(" ");
              if (operation === "has-session") {
                channel.exit(tmux.has(name) ? 0 : 1);
                channel.end();
                return;
              }
              if (operation === "new-session") tmux.set(name, "fixture tmux ready\r\n");
              if (!tmux.has(name)) {
                channel.exit(1);
                channel.end();
                return;
              }
              channel.write("\u001b[2J\u001b[H" + tmux.get(name));
              channel.on("data", (data) => {
                tmux.set(name, (tmux.get(name) + data.toString()).slice(-65536));
                channel.write(data);
              });
              return;
            }
            if (info.command === "hang") return;
            if (info.command === "drop") {
              client.end();
              return;
            }
            const output =
              info.command === "large" ? "x".repeat(200000) : `result:${info.command}\n`;
            setTimeout(() => {
              channel.write(output);
              if (info.command === "fail") channel.stderr.write("fixture failure\n");
              channel.exit(info.command === "fail" ? 9 : 0);
              channel.end();
            }, options.execDelay ?? 5);
          });
          session.on("sftp", (accept) => {
            if (options.hangSftp) return;
            const sftp = accept();
            const handles = new Map();
            let next = 0;
            const status = utils.sftp.STATUS_CODE;
            const guarded =
              (fn) =>
              (...args) => {
                try {
                  fn(...args);
                } catch {
                  sftp.status(args[0], status.NO_SUCH_FILE);
                }
              };
            const attrs = (stat) => ({
              mode: stat.mode,
              uid: stat.uid,
              gid: stat.gid,
              size: stat.size,
              atime: Math.floor(stat.atimeMs / 1000),
              mtime: Math.floor(stat.mtimeMs / 1000),
            });
            const handle = (value) => {
              const bytes = Buffer.alloc(4);
              bytes.writeUInt32BE(++next);
              handles.set(next, value);
              return bytes;
            };
            const lookup = (bytes) => handles.get(bytes.readUInt32BE());
            sftp.on(
              "REALPATH",
              guarded((req, value) => {
                const actual = fs.realpathSync(remote(value));
                const name = "/" + path.relative(directory, actual).split(path.sep).join("/");
                sftp.name(req, [
                  { filename: name, longname: name, attrs: attrs(fs.statSync(actual)) },
                ]);
              }),
            );
            sftp.on(
              "STAT",
              guarded((req, value) => sftp.attrs(req, attrs(fs.statSync(remote(value))))),
            );
            sftp.on(
              "LSTAT",
              guarded((req, value) => sftp.attrs(req, attrs(fs.lstatSync(remote(value))))),
            );
            sftp.on(
              "OPENDIR",
              guarded((req, value) =>
                sftp.handle(
                  req,
                  handle({
                    entries: fs.readdirSync(remote(value)).map((name) => ({
                      filename: name,
                      longname: name,
                      attrs: attrs(fs.lstatSync(path.join(remote(value), name))),
                    })),
                    done: false,
                  }),
                ),
              ),
            );
            sftp.on(
              "READDIR",
              guarded((req, bytes) => {
                const entry = lookup(bytes);
                if (entry.done) sftp.status(req, status.EOF);
                else {
                  entry.done = true;
                  sftp.name(req, entry.entries);
                }
              }),
            );
            sftp.on(
              "OPEN",
              guarded((req, value, flags, permissions) => {
                sftp.handle(
                  req,
                  handle({
                    fd: fs.openSync(
                      remote(value),
                      utils.sftp.flagsToString(flags),
                      permissions.mode ?? 0o600,
                    ),
                  }),
                );
              }),
            );
            sftp.on(
              "READ",
              guarded((req, bytes, offset, length) => {
                const buffer = Buffer.alloc(length);
                const count = fs.readSync(lookup(bytes).fd, buffer, 0, length, offset);
                count ? sftp.data(req, buffer.subarray(0, count)) : sftp.status(req, status.EOF);
              }),
            );
            sftp.on(
              "WRITE",
              guarded((req, bytes, offset, data) => {
                fs.writeSync(lookup(bytes).fd, data, 0, data.length, offset);
                sftp.status(req, status.OK);
              }),
            );
            sftp.on(
              "CLOSE",
              guarded((req, bytes) => {
                const entry = lookup(bytes);
                if (entry.fd !== undefined) fs.closeSync(entry.fd);
                handles.delete(bytes.readUInt32BE());
                sftp.status(req, status.OK);
              }),
            );
            sftp.on(
              "FSTAT",
              guarded((req, bytes) => sftp.attrs(req, attrs(fs.fstatSync(lookup(bytes).fd)))),
            );
            sftp.on(
              "FSETSTAT",
              guarded((req, bytes, permissions) => {
                if (permissions.mode !== undefined)
                  fs.fchmodSync(lookup(bytes).fd, permissions.mode);
                sftp.status(req, status.OK);
              }),
            );
            sftp.on(
              "MKDIR",
              guarded((req, value, permissions) => {
                fs.mkdirSync(remote(value), { mode: permissions.mode });
                sftp.status(req, status.OK);
              }),
            );
            sftp.on(
              "RMDIR",
              guarded((req, value) => {
                fs.rmdirSync(remote(value));
                sftp.status(req, status.OK);
              }),
            );
            sftp.on(
              "REMOVE",
              guarded((req, value) => {
                fs.unlinkSync(remote(value));
                sftp.status(req, status.OK);
              }),
            );
            sftp.on(
              "RENAME",
              guarded((req, from, to) => {
                fs.renameSync(remote(from), remote(to));
                sftp.status(req, status.OK);
              }),
            );
            sftp.on(
              "SETSTAT",
              guarded((req, value, permissions) => {
                if (permissions.mode !== undefined) fs.chmodSync(remote(value), permissions.mode);
                sftp.status(req, status.OK);
              }),
            );
            sftp.on("close", () => {
              for (const handle of handles.values())
                if (handle.fd !== undefined) {
                  try {
                    fs.closeSync(handle.fd);
                  } catch {}
                }
            });
          });
        });
        client.on("tcpip", (accept, reject, info) => {
          if (options.denyForward) {
            reject();
            return;
          }
          const destination = net.connect({ host: info.destIP, port: info.destPort });
          destination.on("error", () => {
            destination.destroy();
            reject();
          });
          destination.once("connect", () => {
            const channel = accept();
            channel.on("error", () => destination.destroy());
            channel.once("close", () => destination.destroy());
            destination.pipe(channel).pipe(destination);
          });
        });
        client.on("request", (accept, reject, name, info) => {
          if (name === "tcpip-forward") {
            const listener = net.createServer((socket) => {
              client.forwardOut(
                info.bindAddr,
                listener.address().port,
                socket.remoteAddress,
                socket.remotePort,
                (error, channel) => {
                  if (error) socket.destroy();
                  else {
                    channel.on("error", () => socket.destroy());
                    socket.pipe(channel).pipe(socket);
                    channel.once("close", () => socket.destroy());
                  }
                },
              );
            });
            listener.on("error", () => reject());
            listener.listen(info.bindPort, "127.0.0.1", () => {
              forwards.add(listener);
              accept(listener.address().port);
            });
            client.once("close", () => listener.close());
          } else if (name === "cancel-tcpip-forward") {
            const listener = [...forwards].find((s) => s.address()?.port === info.bindPort);
            listener?.close();
            forwards.delete(listener);
            accept();
          } else reject();
        });
      });
    });
    await new Promise((resolve, reject) => {
      const failed = (error) => reject(error);
      server.once("error", failed);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", failed);
        resolve();
      });
    });
    return {
      server,
      port: server.address().port,
      publicKey,
      key,
      fingerprint,
      directory,
      connections,
      shells,
      forwards,
      counts,
      tmux,
      close,
    };
  } catch (error) {
    return rollback(error, close);
  }
}
export async function configuredManager(fixture, options = {}) {
  const directory = fs.mkdtempSync(
    path.join(options.temporaryRoot ?? os.tmpdir(), "ssh-manager-test-"),
  );
  const managerOptions = {
    stateDirectory: directory,
    knownHosts: [],
    limits: { authTimeout: 1500, channelTimeout: 1000, idleTimeout: 60000, ...options.limits },
  };
  let manager,
    closed = false,
    cleanupError;
  // Preserve the synchronous close interface for existing independently-owned callers.
  const close = () => {
    if (!closed) {
      closed = true;
      try {
        cleanupSync([
          () => manager?.shutdown(),
          () => fs.rmSync(directory, { recursive: true, force: true }),
        ]);
      } catch (error) {
        cleanupError = error;
      }
    }
    if (cleanupError) throw cleanupError;
  };
  try {
    manager = new SSHManager(managerOptions);
    await manager.vaultInitialize(operator, vaultPassword);
    const credential = manager.addCredential(
      operator,
      { kind: "vault", name: "fixture", secretKind: "password" },
      { value: password },
    );
    const profile = manager.createProfile(operator, {
      name: "fixture",
      host: "127.0.0.1",
      port: fixture.port,
      username: "fixture-user",
      credentialId: credential.id,
      fileRoots: ["/allowed"],
    });
    manager.confirmHost(
      operator,
      profile.id,
      profile.revision,
      fixture.publicKey.toString("base64"),
      fixture.fingerprint,
    );
    manager.setGrants(operator, profile.id, profile.revision, allCapabilities);
    return {
      get manager() {
        return manager;
      },
      directory,
      profile,
      credential,
      restart: () => {
        if (closed) throw new Error("SSH fixture manager is closed.");
        manager.shutdown();
        manager = new SSHManager(managerOptions);
        return manager;
      },
      close,
    };
  } catch (error) {
    return rollback(error, close);
  }
}

/** Own one synthetic counterpart and its configured manager for the test lifetime. */
export async function managedFixture(t, { ssh = {}, ...managerOptions } = {}) {
  const fixture = await sshFixture(ssh);
  let closeManager;
  const close = onceAsync(() => cleanupAsync([() => closeManager?.(), () => fixture.close()]));
  try {
    // Register before asynchronous manager setup; setup itself also rolls back on failure.
    t.after(close);
    const ctx = await configuredManager(fixture, managerOptions);
    closeManager = ctx.close;
    ctx.fixture = fixture;
    ctx.close = close;
    return ctx;
  } catch (error) {
    return rollback(error, close);
  }
}
