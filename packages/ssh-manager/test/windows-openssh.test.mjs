import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn, execFileSync } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { Readable } from "node:stream";
import ssh2 from "ssh2";
import { SSHManager } from "../dist/index.js";
import { operator, agent, allCapabilities, until } from "./fixture.mjs";

// Own daemon/config/keys only. Never change the installed service or a user's SSH files.
test(
  "native Windows OpenSSH: start directory, PTY, PowerShell, SFTP and loopback tunnel",
  {
    skip: process.platform !== "win32" || process.env.SSH_MANAGER_WINDOWS_TESTS !== "1",
    timeout: 60000,
  },
  async (t) => {
    const sshd = process.env.SSH_MANAGER_SSHD;
    assert.ok(sshd && path.isAbsolute(sshd));
    const directory = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "ssh-windows-fixture-")),
    );
    let manager, daemon, echo;
    let diagnostics = "";
    t.after(async () => {
      manager?.shutdown();
      if (echo) await new Promise((resolve) => echo.close(resolve));
      if (daemon && daemon.exitCode === null && daemon.signalCode === null) {
        daemon.kill();
        await until(() => daemon.exitCode !== null || daemon.signalCode !== null, 10000);
      }
      fs.rmSync(directory, { recursive: true, force: true });
    });
    const key = () =>
      generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({
        format: "pem",
        type: "pkcs1",
      });
    const hostKey = key(),
      clientKey = key();
    const hostSSH = ssh2.utils.parseKey(hostKey).getPublicSSH();
    const clientSSH = ssh2.utils.parseKey(clientKey).getPublicSSH();
    const write = (name, contents) => {
      const file = path.join(directory, name);
      fs.writeFileSync(file, contents, { mode: 0o600 });
      return file.replaceAll("\\", "/");
    };
    const hostFile = write("host.key", hostKey);
    // Node's Unix mode cannot establish Windows ACLs. Restrict our newly-created key only.
    const protectKey = `$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'; $acl = New-Object System.Security.AccessControl.FileSecurity; $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User; $acl.SetOwner($sid); $acl.SetAccessRuleProtection($true, $false); foreach ($identity in @($sid, (New-Object System.Security.Principal.SecurityIdentifier 'S-1-5-18'), (New-Object System.Security.Principal.SecurityIdentifier 'S-1-5-32-544'))) { $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($identity, 'FullControl', 'Allow'); $acl.AddAccessRule($rule) }; Set-Acl -LiteralPath $env:SSH_MANAGER_FIXTURE_KEY -AclObject $acl`;
    execFileSync(
      path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      [
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(protectKey, "utf16le").toString("base64"),
      ],
      { env: { ...process.env, SSH_MANAGER_FIXTURE_KEY: hostFile }, windowsHide: true },
    );
    const clientFile = write("client.key", clientKey);
    const authorized = write(
      "authorized_keys",
      `ssh-rsa ${clientSSH.toString("base64")} disposable-fixture\n`,
    );
    const reservation = net.createServer();
    await new Promise((resolve) => reservation.listen(0, "127.0.0.1", resolve));
    const port = reservation.address().port;
    await new Promise((resolve) => reservation.close(resolve));
    const config = write(
      "sshd_config",
      `Port ${port}\nListenAddress 127.0.0.1\nHostKey "${hostFile}"\nPidFile "${directory.replaceAll("\\", "/")}/sshd.pid"\nAuthorizedKeysFile "${authorized}"\nStrictModes no\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nAllowUsers ${os.userInfo().username}\nAllowTcpForwarding yes\nPermitTTY yes\nSubsystem sftp internal-sftp\n`,
    );
    daemon = spawn(sshd, ["-D", "-e", "-f", config], {
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    });
    daemon.stderr.on("data", (bytes) => {
      diagnostics = (diagnostics + bytes).slice(-16384);
    });
    await until(() => {
      if (daemon.exitCode !== null) assert.fail(diagnostics);
      return new Promise((resolve) => {
        const socket = net.connect(port, "127.0.0.1");
        socket.once("error", () => resolve(false));
        socket.once("connect", () => {
          socket.destroy();
          resolve(true);
        });
      });
    }, 10000);
    manager = new SSHManager({ stateDirectory: path.join(directory, "state"), knownHosts: [] });
    const credential = manager.addCredential(operator, {
      name: "disposable",
      kind: "key-file",
      path: clientFile,
    });
    const root = `/${directory.replaceAll("\\", "/")}`;
    const profile = manager.createProfile(operator, {
      name: "isolated Windows",
      host: "127.0.0.1",
      port,
      username: os.userInfo().username,
      credentialId: credential.id,
      shell: "powershell",
      fileRoots: [root],
    });
    manager.confirmHost(
      operator,
      profile.id,
      1,
      hostSSH.toString("base64"),
      "SHA256:" + createHash("sha256").update(hostSSH).digest("base64").replace(/=+$/, ""),
    );
    manager.setGrants(operator, profile.id, 1, allCapabilities);
    const start = await manager.files.startDirectory(operator, profile.id);
    assert.ok(start.path.startsWith("/") && !start.path.includes("\\"));
    assert.notEqual(start.path, root);
    await assert.rejects(manager.files.list(agent, profile.id, start.path), {
      code: "PATH_DENIED",
    });
    const script = Buffer.from(
      "[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false); [Console]::Write('native-powershell-✓')",
      "utf16le",
    ).toString("base64");
    const job = await manager.jobs.start(
      agent,
      profile.id,
      `powershell.exe -NoProfile -NonInteractive -EncodedCommand ${script}`,
    );
    await until(() => manager.jobs.read(agent, job.id).job.state !== "running", 10000);
    const result = manager.jobs.read(agent, job.id);
    assert.equal(result.job.state, "succeeded");
    assert.equal(
      result.output.parts
        .filter((part) => part.stream === "stdout")
        .map((part) => part.text)
        .join(""),
      "native-powershell-✓",
    );
    const terminal = await manager.sessions.create(agent, profile.id);
    await manager.sessions.attach(agent, terminal.id);
    manager.sessions.writer(agent, terminal.id);
    assert.ok(
      manager.sessions.input(agent, terminal.id, "echo disposable-terminal\r").accepted > 0,
    );
    manager.sessions.resize(agent, terminal.id, 100, 32);
    await until(() => manager.sessions.read(agent, terminal.id).output.parts.length, 10000);
    manager.sessions.detach(agent, terminal.id);
    manager.sessions.close(agent, terminal.id);
    let progress = 0;
    const remote = `${root}/transfer.txt`;
    await manager.files.upload(agent, profile.id, remote, Readable.from(["native-sftp"]), {
      progress: (bytes) => {
        progress = bytes;
      },
    });
    assert.equal(progress, 11);
    const data = await manager.files.read(agent, profile.id, remote);
    assert.equal(Buffer.from(data.data, "base64").toString(), "native-sftp");
    await manager.files.mutate(agent, profile.id, "remove", remote);
    echo = net.createServer((socket) => socket.pipe(socket));
    await new Promise((resolve) => echo.listen(0, "127.0.0.1", resolve));
    const tunnel = await manager.tunnels.create(agent, profile.id, {
      kind: "local",
      listenPort: 0,
      destinationHost: "127.0.0.1",
      destinationPort: echo.address().port,
    });
    const echoed = await new Promise((resolve, reject) => {
      const socket = net.connect(tunnel.listenPort, "127.0.0.1");
      socket.once("error", reject);
      socket.setTimeout(5000, () => socket.destroy(new Error("Tunnel timed out")));
      socket.once("connect", () => socket.write("native-tunnel"));
      socket.once("data", (bytes) => {
        socket.destroy();
        resolve(bytes.toString());
      });
    });
    assert.equal(echoed, "native-tunnel");
    await manager.tunnels.close(agent, tunnel.id);
  },
);
