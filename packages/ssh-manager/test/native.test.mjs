import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn, spawnSync } from "node:child_process";
import { generateKeyPairSync, createHash } from "node:crypto";
import ssh2 from "ssh2";
import { SSHManager } from "../dist/index.js";
import { operator, agent, allCapabilities, vaultPassword, until } from "./fixture.mjs";

// Explicit opt-in: never use a developer's SSH daemon, agent, keys, tmux server or authorized_keys.
test(
  "native OpenSSH encrypted-key authentication and actual tmux survive manager restart",
  { skip: process.env.SSH_MANAGER_NATIVE_TESTS !== "1" },
  async (t) => {
    const sshd = process.env.SSH_MANAGER_SSHD,
      tmux = process.env.SSH_MANAGER_TMUX;
    assert.ok(sshd && path.isAbsolute(sshd));
    assert.ok(tmux && path.isAbsolute(tmux));
    const directory = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "ssh-native-acceptance-")),
    );
    const key = () => generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
    const hostKey = key().export({ format: "pem", type: "pkcs1" });
    const authKey = key();
    const authPem = authKey.export({ format: "pem", type: "pkcs1" });
    const publicSSH = ssh2.utils.parseKey(authPem).getPublicSSH();
    const hostSSH = ssh2.utils.parseKey(hostKey).getPublicSSH();
    const passphrase = "ephemeral-key-passphrase";
    const write = (name, contents) => {
      const file = path.join(directory, name);
      fs.writeFileSync(file, contents, { mode: 0o600 });
      return file;
    };
    const hostFile = write("host.key", hostKey),
      authFile = write(
        "client.key",
        authKey.export({ format: "pem", type: "pkcs1", cipher: "aes-256-cbc", passphrase }),
      );
    const tmuxSocket = path.join(directory, `tmux-${os.userInfo().uid}`, "default"),
      executable = path.join(directory, "tmux");
    fs.mkdirSync(path.dirname(tmuxSocket), { mode: 0o700 });
    fs.writeFileSync(
      executable,
      `#!/bin/sh\nexec '${tmux.replaceAll("'", "'\\''")}' -S '${tmuxSocket.replaceAll("'", "'\\''")}' "$@"\n`,
      { mode: 0o700 },
    );
    const authorized = write(
      "authorized_keys",
      `ssh-rsa ${publicSSH.toString("base64")} ephemeral-fixture\n`,
    );
    const reservation = net.createServer();
    await new Promise((r) => reservation.listen(0, "127.0.0.1", r));
    const port = reservation.address().port;
    await new Promise((r) => reservation.close(r));
    const configuration = write(
      "sshd_config",
      `Port ${port}\nListenAddress 127.0.0.1\nHostKey ${hostFile}\nPidFile ${directory}/sshd.pid\nAuthorizedKeysFile ${authorized}\nStrictModes no\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nUsePAM no\nAllowUsers ${os.userInfo().username}\nAllowTcpForwarding yes\nPermitTTY yes\nSetEnv PATH=${directory}:${process.env.PATH} TMUX_TMPDIR=${directory}\nSubsystem sftp internal-sftp\n`,
    );
    const daemon = spawn(sshd, ["-D", "-e", "-f", configuration], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let diagnostics = "",
      manager;
    daemon.stderr.on("data", (bytes) => {
      diagnostics += bytes;
    });
    const agentSocket = path.join(directory, "agent.socket");
    const localAgent = spawn("ssh-agent", ["-D", "-a", agentSocket], { stdio: "ignore" });
    t.after(async () => {
      manager?.shutdown();
      localAgent.kill();
      spawnSync(tmux, ["-S", tmuxSocket, "kill-server"], { stdio: "ignore" });
      daemon.kill();
      await until(
        () =>
          (daemon.exitCode !== null || daemon.signalCode !== null) &&
          (localAgent.exitCode !== null || localAgent.signalCode !== null),
      );
      fs.rmSync(directory, { recursive: true, force: true });
    });
    await until(async () => {
      if (daemon.exitCode !== null) assert.fail(diagnostics);
      return new Promise((resolve) => {
        const socket = net.connect(port, "127.0.0.1");
        socket.on("error", () => resolve(false));
        socket.once("connect", () => {
          socket.destroy();
          resolve(true);
        });
      });
    });
    const stateDirectory = path.join(directory, "state");
    manager = new SSHManager({ stateDirectory, knownHosts: [] });
    await manager.vaultInitialize(operator, vaultPassword);
    const phrase = manager.addCredential(
      operator,
      { kind: "vault", secretKind: "passphrase", name: "key phrase" },
      { value: passphrase },
    );
    const credential = manager.addCredential(operator, {
      kind: "key-file",
      name: "native key",
      path: authFile,
      passphraseId: phrase.id,
    });
    const profile = manager.createProfile(operator, {
      name: "native fixture",
      host: "127.0.0.1",
      port,
      username: os.userInfo().username,
      credentialId: credential.id,
      fileRoots: [directory],
    });
    manager.confirmHost(
      operator,
      profile.id,
      1,
      hostSSH.toString("base64"),
      "SHA256:" + createHash("sha256").update(hostSSH).digest("base64").replace(/=+$/, ""),
    );
    manager.setGrants(operator, profile.id, 1, allCapabilities);
    const job = await manager.jobs.start(agent, profile.id, "printf native-open-ssh");
    await until(() => manager.jobs.read(agent, job.id).job.state !== "running");
    assert.equal(manager.jobs.read(agent, job.id).job.exitCode, 0);
    assert.ok(
      manager.jobs.read(agent, job.id).output.parts.some((p) => p.text.includes("native-open-ssh")),
    );
    await until(() => fs.existsSync(agentSocket));
    const addition = spawnSync("ssh-add", ["-"], {
      env: { ...process.env, SSH_AUTH_SOCK: agentSocket },
      input: authPem,
      encoding: "utf8",
    });
    assert.equal(addition.status, 0, addition.stderr);
    const agentCredential = manager.addCredential(operator, {
      kind: "agent",
      name: "private native agent",
      socket: agentSocket,
    });
    const agentProfile = manager.createProfile(operator, {
      name: "agent fixture",
      host: "127.0.0.1",
      port,
      username: os.userInfo().username,
      credentialId: agentCredential.id,
    });
    manager.confirmHost(
      operator,
      agentProfile.id,
      1,
      hostSSH.toString("base64"),
      "SHA256:" + createHash("sha256").update(hostSSH).digest("base64").replace(/=+$/, ""),
    );
    manager.setGrants(operator, agentProfile.id, 1, allCapabilities);
    const signed = await manager.jobs.start(agent, agentProfile.id, "printf native-agent");
    await until(() => manager.jobs.read(agent, signed.id).job.state !== "running");
    assert.equal(manager.jobs.read(agent, signed.id).job.exitCode, 0);
    assert.equal(
      (await manager.files.stat(agent, profile.id, authorized)).size,
      fs.statSync(authorized).size,
    );
    const plain = await manager.sessions.create(agent, profile.id);
    const terminal = await manager.sessions.create(agent, profile.id, { tmux: true });
    await manager.sessions.attach(agent, terminal.id);
    manager.sessions.writer(agent, terminal.id);
    manager.sessions.input(agent, terminal.id, "printf '%s%s\\n' 'preserved-native-' 'terminal'\r");
    await until(() =>
      manager.sessions
        .read(agent, terminal.id)
        .output.parts.some((p) => p.text.includes("preserved-native-terminal")),
    );
    manager.shutdown();
    manager = new SSHManager({ stateDirectory, knownHosts: [] });
    await manager.vaultUnlock(operator, vaultPassword);
    assert.equal(manager.sessions.read(agent, plain.id).session.state, "lost");
    assert.equal(manager.sessions.read(agent, terminal.id).session.state, "recoverable");
    await manager.sessions.recover(agent, terminal.id);
    await until(() =>
      manager.sessions
        .read(agent, terminal.id)
        .output.parts.some((p) => p.text.includes("preserved-native-terminal")),
    );
    manager.closeConnection(
      agent,
      manager.connections(agent).find((c) => c.targetId === profile.id).id,
    );
    const killed = spawnSync(tmux, ["-S", tmuxSocket, "kill-server"], { encoding: "utf8" });
    assert.equal(killed.status, 0, "The fixture must kill its own isolated tmux server.");
    await assert.rejects(manager.sessions.recover(agent, terminal.id), {
      code: "TMUX_UNAVAILABLE",
    });
  },
);
