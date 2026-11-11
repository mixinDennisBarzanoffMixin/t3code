// @effect-diagnostics nodeBuiltinImport:off -- Chromium integration fixture owns temporary profile files.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { chromium } from "playwright-core";
import { expect, it } from "vite-plus/test";
import { DebugBrowser } from "./DebugBrowser.ts";
import { ServerBrowserContexts } from "./ServerBrowserContexts.ts";
import { evaluate } from "./ServerBrowserPage.ts";

it("allows an external IDE session to resume a managed debug browser without terminating evaluation", async () => {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-debug-test-"));
  const pool = new ServerBrowserContexts({
    profilesDir: directory,
    executable: async () => chromium.executablePath(),
  });
  try {
    const context = await pool.contextFor("default", "test", true);
    expect(await pool.contextFor("default", "test", true)).toBe(context);
    const endpoint = pool.debugEndpoint(context)!;
    expect(endpoint).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const page = await context.newPage();
    const own = await context.newCDPSession(page);
    const debug = new DebugBrowser(endpoint);
    await debug.watch(own);
    const external = await chromium.connectOverCDP(endpoint);
    try {
      const target = external.contexts()[0]!.pages()[0]!;
      const ide = await target.context().newCDPSession(target);
      await ide.send("Debugger.enable");
      const paused = Promise.withResolvers<void>();
      ide.once("Debugger.paused", () => paused.resolve());
      const resumed = Promise.withResolvers<void>();
      own.once("Debugger.resumed", () => resumed.resolve());
      const result = expect(
        debug.run(() => evaluate(own, { expression: "debugger; 42" }, 2000, debug.signal)),
      ).rejects.toThrow("paused in the IDE");
      await paused.promise;
      await result;
      expect(debug.paused).toBe(true);
      await expect(debug.run(async () => "must not run")).rejects.toThrow("paused in the IDE");
      await ide.send("Debugger.resume");
      await resumed.promise;
      expect(debug.paused).toBe(false);
      expect(
        await debug.run(() => evaluate(own, { expression: "6 * 7" }, 2000, debug.signal)),
      ).toBe(42);
      await ide.detach();
    } finally {
      await external.close();
    }
    await pool.close();
    expect(await NodeFSP.readdir(directory)).toEqual([]);
  } finally {
    await pool.close();
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
});
