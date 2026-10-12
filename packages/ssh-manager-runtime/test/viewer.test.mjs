import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRuntime } from "../dist/server.js";
import {
  sshFixture,
  operator,
  second,
  password,
  vaultPassword,
  allCapabilities,
  until,
} from "../../ssh-manager/test/fixture.mjs";

test(
  "real browser viewer resumes typing and paste after switching away and reattaches without duplicate output",
  { skip: process.env.SSH_MANAGER_BROWSER_TESTS !== "1", timeout: 45000 },
  async (t) => {
    const root = fileURLToPath(new URL("../../../", import.meta.url));
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ssh-viewer-browser-"));
    const fixture = await sshFixture();
    let runtime;
    const browserSession = `ssh-manager-viewer-${process.pid}`;
    const browser = (args, input) =>
      new Promise((resolve, reject) => {
        const child = execFile(
          "agent-browser",
          ["--session", browserSession, "--allowed-domains", "127.0.0.1", ...args],
          { encoding: "utf8", timeout: 15000, maxBuffer: 64 * 1024 },
          (error, stdout) => (error ? reject(error) : resolve(stdout)),
        );
        child.stdin.end(input);
      });
    t.after(async () => {
      await browser(["close"]).catch(() => {});
      await runtime?.close();
      await fixture.close();
      fs.rmSync(directory, { recursive: true, force: true });
    });
    const assets = path.join(root, "dist/ssh-runtime/viewer");
    runtime = await createRuntime({
      stateDirectory: directory,
      knownHosts: [],
      viewerDirectory: path.join(root, "packages/ssh-manager-runtime/viewer"),
      assets: {
        "/xterm.js": path.join(assets, "xterm.js"),
        "/xterm.css": path.join(assets, "xterm.css"),
        "/fit.js": path.join(assets, "fit.js"),
      },
    });
    const manager = runtime.manager;
    await manager.vaultInitialize(operator, vaultPassword);
    const credential = manager.addCredential(
      operator,
      { kind: "vault", name: "browser fixture", secretKind: "password" },
      { value: password },
    );
    const profile = manager.createProfile(operator, {
      name: "browser fixture",
      host: "127.0.0.1",
      port: fixture.port,
      username: "fixture-user",
      credentialId: credential.id,
    });
    manager.confirmHost(
      operator,
      profile.id,
      1,
      fixture.publicKey.toString("base64"),
      fixture.fingerprint,
    );
    manager.setGrants(operator, profile.id, 1, allCapabilities);
    const session = await manager.sessions.create(operator, profile.id);
    await browser(["open", runtime.url]);
    assert.match(await browser(["snapshot", "-i"]), /Attach terminal/);
    const attach = async () => {
      // Only ephemeral fixture tokens enter the browser; no auth state is saved.
      await browser(
        ["eval", "--stdin"],
        `document.querySelector("#token").value=${JSON.stringify(runtime.agentToken)};\n` +
          `document.querySelector("#session").value=${JSON.stringify(session.id)};\n"fixture-filled";`,
      );
      await browser(["find", "role", "button", "click", "--name", "Attach terminal"]);
      await browser([
        "wait",
        "--fn",
        'document.querySelector("#status").textContent.startsWith("running")',
      ]);
      await browser([
        "wait",
        "--fn",
        'document.querySelector("#terminal").textContent.includes("fixture ready")',
      ]);
    };
    await attach();
    await browser(["snapshot", "-i"]);
    await browser(["find", "role", "button", "click", "--name", "Acquire input"]);
    await until(() => !!manager.sessions.read(operator, session.id).session.writer);
    await browser([
      "wait",
      "--fn",
      'document.activeElement?.classList.contains("xterm-helper-textarea")',
    ]);
    // Terminal input uses keyboard events, not direct textarea value insertion.
    for (const key of "viewerinputcheck") await browser(["press", key]);
    await browser([
      "wait",
      "--fn",
      'document.querySelector(".xterm-rows").textContent.includes("viewerinputcheck")',
    ]);
    // Advance only the fixture backend's Date clock; real browser events and
    // WebSocket/SSH input still traverse the production viewer and API.
    t.after(() => t.mock.timers.reset());
    await browser(["tab", "new", "--label", "clipboard", runtime.url]);
    const expireWhileAway = async () => {
      await browser(["tab", "clipboard"]);
      t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
      t.mock.timers.setTime(Date.now() + 31000);
      try {
        for (
          let attempt = 0;
          attempt < 40 && manager.sessions.read(operator, session.id).session.writer;
          attempt++
        )
          await new Promise((resolve) => setTimeout(resolve, 50));
        assert.equal(manager.sessions.read(operator, session.id).session.writer, undefined);
      } finally {
        t.mock.timers.reset();
      }
      assert.equal(manager.sessions.read(operator, session.id).session.state, "running");
    };
    for (const mode of ["paste", "typing"]) {
      await expireWhileAway();
      await browser(["tab", "t1"]);
      await browser(["focus", ".xterm-helper-textarea"]);
      const marker = mode === "paste" ? "resumedpastecheck" : "resumedtypingcheck";
      if (mode === "paste") {
        await browser(
          ["eval", "--stdin"],
          "const clipboard = new DataTransfer();\n" +
            'clipboard.setData("text/plain", "resumedpastecheck");\n' +
            'document.querySelector(".xterm-helper-textarea").dispatchEvent(new ClipboardEvent("paste", {clipboardData: clipboard, bubbles: true, cancelable: true}));\n' +
            '"paste-dispatched";',
        );
      } else for (const key of marker) await browser(["press", key]);
      await browser([
        "wait",
        "--fn",
        'document.querySelector(".xterm-rows").textContent.includes(' +
          JSON.stringify(marker) +
          ")",
      ]);
      assert.ok(manager.sessions.read(operator, session.id).session.writer);
    }
    await expireWhileAway();
    await manager.sessions.attach(second, session.id);
    manager.sessions.writer(second, session.id);
    await browser(["tab", "t1"]);
    await browser(["focus", ".xterm-helper-textarea"]);
    await browser(
      ["eval", "--stdin"],
      "const blockedClipboard = new DataTransfer();\n" +
        'blockedClipboard.setData("text/plain", "blockedpastecheck");\n' +
        'document.querySelector(".xterm-helper-textarea").dispatchEvent(new ClipboardEvent("paste", {clipboardData: blockedClipboard, bubbles: true, cancelable: true}));\n' +
        '"paste-dispatched";',
    );
    await browser(["wait", "--fn", "queuedInputBytes === 0 && writerRequest === undefined"]);
    assert.equal(manager.sessions.read(operator, session.id).session.writer, second.id);
    const blocked = await browser(
      ["eval", "--stdin"],
      'document.querySelector(".xterm-rows").textContent;',
    );
    assert.doesNotMatch(blocked, /blockedpastecheck/);
    assert.match(
      await browser(["eval", "--stdin"], 'document.querySelector("#status").textContent;'),
      /another/i,
    );
    manager.sessions.detach(second, session.id);
    await browser(["snapshot", "-i"]);
    await browser(["find", "role", "button", "click", "--name", "Detach"]);
    await until(() => !manager.sessions.read(operator, session.id).session.writer);
    assert.equal(manager.sessions.read(operator, session.id).session.state, "running");
    await attach();
    const rendered = await browser(
      ["eval", "--stdin"],
      'document.querySelector(".xterm-rows").textContent;',
    );
    assert.equal(rendered.split("viewerinputcheck").length - 1, 1);
    assert.equal(await browser(["errors"]), "");
    assert.doesNotMatch(await browser(["console"]), /Refused to (?:apply|execute)/);
    assert.equal(fixture.counts.shell, 1);
    const storage = JSON.parse(
      await browser(
        ["eval", "--stdin"],
        "({local:localStorage.length,session:sessionStorage.length,url:location.href});",
      ),
    );
    assert.doesNotMatch(storage.url, /token=|sessionId=/);
    assert.equal(storage.local, 0);
    assert.equal(storage.session, 0);
    if (process.env.SSH_MANAGER_VIEWER_SCREENSHOT)
      await browser(["screenshot", path.resolve(process.env.SSH_MANAGER_VIEWER_SCREENSHOT)]);
    console.log(
      "Browser viewer: input/paste after lease expiry, exclusive writer, detach/reattach and memory-only tokens passed.",
    );
  },
);
