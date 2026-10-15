import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { mcpHarness, tick } from "../../packages/ssh-manager-mcp/test/stdio-harness.mjs";
import { catalog } from "../../packages/ssh-manager-runtime/dist/catalog.js";

// Real published SDK + official stdio decoder and actual Writable callbacks.
// The trusted invocation returns canonical fixture data: no native/SSH claim.
const cleanup = [];
const t = { after: (fn) => cleanup.push(fn) };
const expected = Object.entries(catalog)
  .filter(([, entry]) => !entry.operator)
  .map(([name]) => name)
  .sort();
const start = performance.now();
const counts = { legacy: 0, modern: 0 };
try {
  const peers = await Promise.all(
    ["legacy", "modern"].map(async (era) => {
      const h = await mcpHarness(t, { era });
      assert.deepEqual(
        (await h.call(1, "tools/list")).result.tools.map((tool) => tool.name).sort(),
        expected,
      );
      h.messages.length = 0;
      return { era, h };
    }),
  );
  while (performance.now() - start < 602000) {
    await Promise.all(
      peers.map(async ({ era, h }) => {
        const results = await Promise.all(
          Array.from({ length: 8 }, (_, index) =>
            h.call(index + 1, "tools/call", { name: "ssh_hosts_list", arguments: {} }),
          ),
        );
        for (const result of results)
          assert.deepEqual(result.result.structuredContent, { data: [] });
        await tick();
        assert.deepEqual(h.handle.usage(), {
          requests: 0,
          messages: 0,
          handlers: 0,
          queuedMessages: 0,
          clients: 1,
          factories: 0,
          calls: 0,
          waitingCalls: 0,
          outputMessages: 0,
          outputBytes: 0,
        });
        assert.equal(h.errors.length, 0);
        counts[era] += 8;
        h.messages.length = 0;
      }),
    );
    await sleep(250);
  }
  console.log(
    JSON.stringify({
      elapsedSeconds: (performance.now() - start) / 1000,
      completed: counts,
      toolsPerEra: expected.length,
      requests: 8,
      calls: 2,
      messages: 16,
      sdk: "published @modelcontextprotocol/server 2.3.1",
      nativeSshQualified: false,
    }),
  );
} finally {
  for (const close of cleanup.reverse()) await close();
}
