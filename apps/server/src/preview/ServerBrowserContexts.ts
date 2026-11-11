// @effect-diagnostics nodeBuiltinImport:off globalTimers:off -- Owns Playwright resources and their idle timer outside the Effect runtime.
import { INCOGNITO_BROWSER_PROFILE_ID } from "@t3tools/contracts";
import { constVoid } from "effect/Function";
import * as NodeFSP from "node:fs/promises";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import type { Browser, BrowserContext, CDPSession } from "playwright-core";

import { sandboxDisabled } from "./PreviewBrowserHost.ts";

// Playwright needs its files on disk. createRequire also resolves it from a Node SEA executable.
const requirePlaywright = NodeModule.createRequire(import.meta.url);
const loadPlaywright = () =>
  requirePlaywright("playwright-core") as typeof import("playwright-core");

interface Options {
  readonly profilesDir: string;
  readonly executable: () => Promise<string>;
  /**
   * A path that starts `executable`, such as one that moves Chrome out of the server's cgroup.
   * Released after the whole launch call, since Playwright retries the same path after a glibc race.
   */
  readonly launcher?: (
    executable: string,
  ) => Promise<{ readonly path: string; readonly release: () => Promise<void> } | undefined>;
  readonly diagnose?: (executable: string, cause: unknown) => Promise<unknown>;
  readonly env?: NodeJS.ProcessEnv;
  /** Closes the shared browser once it has held no context for this long. */
  readonly idleBrowserMs?: number;
  readonly onContextClose?: (context: BrowserContext) => void;
}

const UA_PLATFORMS: Partial<Record<NodeJS.Platform, string>> = {
  darwin: "macOS",
  linux: "Linux",
  win32: "Windows",
};

/** Change user agent and Sec-CH-UA together; sites block mismatches. */
const chromeIdentity = (
  headlessUserAgent: string,
  host: { readonly platform: NodeJS.Platform; readonly arch: string; readonly release: string },
) => {
  const version = /HeadlessChrome\/((\d+)[\d.]*)/.exec(headlessUserAgent);
  const fullVersion = version?.[1];
  const major = version?.[2];
  if (!version || !fullVersion || !major) return null;
  const brands = (names: (version: string) => string) => [
    { brand: "Chromium", version: names(major) },
    { brand: "Google Chrome", version: names(major) },
    { brand: "Not A(Brand", version: names("99") },
  ];
  return {
    userAgent: headlessUserAgent.replace(version[0], `Chrome/${major}.0.0.0`),
    userAgentMetadata: {
      brands: brands((value) => value),
      fullVersionList: brands((value) => (value === major ? fullVersion : `${value}.0.0.0`)),
      platform: UA_PLATFORMS[host.platform] ?? "Unknown",
      platformVersion: host.platform === "linux" ? host.release : "",
      architecture: host.arch.startsWith("arm") ? "arm" : "x86",
      bitness: host.arch.endsWith("64") ? "64" : "32",
      model: "",
      mobile: false,
      wow64: false,
    },
  };
};

export const presentAsChrome = async (
  cdp: CDPSession,
  host: { readonly platform: NodeJS.Platform; readonly arch: string },
) => {
  const { userAgent } = await cdp.send("Browser.getVersion");
  const identity = chromeIdentity(userAgent, { ...host, release: NodeOS.release() });
  if (identity) await cdp.send("Emulation.setUserAgentOverride", identity);
};

export class ServerBrowserContexts {
  private readonly options: Options;
  private readonly contexts = new Map<string, Promise<BrowserContext>>();
  private readonly debugDirectories = new Set<string>();
  private readonly debugCleanup = new Set<Promise<void>>();
  private readonly debugEndpoints = new WeakMap<BrowserContext, string>();
  private readonly clearing = new Map<string, Promise<void>>();
  private browser: Promise<Browser> | undefined;
  private closing: Promise<void> | undefined;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private pendingSharedContexts = 0;

  constructor(options: Options) {
    this.options = options;
  }

  private async launchOptions() {
    const executable = await this.options.executable();
    const env = this.options.env ?? process.env;
    return {
      executable,
      env,
      args: [
        "--disable-gpu",
        "--force-device-scale-factor=2",
        "--disable-blink-features=AutomationControlled",
      ],
      ignoreDefaultArgs: ["--enable-automation"],
      headless: true,
      // Only an explicit operator opt-out disables sandboxing. Launch errors never do.
      chromiumSandbox: !sandboxDisabled(env),
    };
  }

  private async launch<A>(executable: string, start: (executablePath: string) => Promise<A>) {
    let release: (() => Promise<void>) | undefined;
    try {
      const launcher = await this.options.launcher?.(executable);
      release = launcher?.release;
      return await start(launcher?.path ?? executable);
    } catch (cause) {
      throw (await this.options.diagnose?.(executable, cause)) ?? cause;
    } finally {
      await release?.().catch(constVoid);
    }
  }

  private sharedBrowser() {
    if (!this.browser) {
      const launched = this.launchOptions().then(async ({ executable, ...options }) => {
        const { chromium } = loadPlaywright();
        const browser = await this.launch(executable, (executablePath) =>
          chromium.launch({ ...options, executablePath }),
        );
        browser.on("disconnected", () => {
          if (this.browser === launched) this.browser = undefined;
        });
        return browser;
      });
      this.browser = launched;
      void launched.catch(() => {
        if (this.browser === launched) this.browser = undefined;
      });
    }
    return this.browser;
  }

  private async sharedContext(options?: Parameters<Browser["newContext"]>[0]) {
    clearTimeout(this.idleTimer);
    this.pendingSharedContexts++;
    const launched = this.sharedBrowser();
    try {
      const context = await (await launched).newContext(options);
      context.on("close", () => this.retireWhenIdle(launched));
      return context;
    } finally {
      this.pendingSharedContexts--;
      this.retireWhenIdle(launched);
    }
  }

  private retireWhenIdle(launched: Promise<Browser>) {
    const delay = this.options.idleBrowserMs;
    if (delay === undefined || this.closing || this.pendingSharedContexts > 0) return;
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => void this.retire(launched), delay);
    this.idleTimer.unref();
  }

  private async retire(launched: Promise<Browser>) {
    const browser = await launched.catch(() => undefined);
    if (!browser || this.browser !== launched || this.pendingSharedContexts > 0) return;
    if (browser.contexts().length > 0) return;
    // Cleared first, so a request during the close launches a fresh browser.
    this.browser = undefined;
    await browser.close().catch(constVoid);
  }

  contextFor(profileId: string, isolationKey?: string, debug = false): Promise<BrowserContext> {
    if (this.closing) return Promise.reject(new Error("The preview browser is closed."));
    const key = JSON.stringify([profileId, isolationKey ?? null, ...(debug ? [true] : [])]);
    const cached = this.contexts.get(key);
    if (cached) return cached;
    const cleared = this.clearing.get(key)?.catch(constVoid) ?? Promise.resolve();
    const pending = cleared
      .then(() => this.createContext(profileId, isolationKey, debug))
      .then(async (context) => {
        context.on("close", () => {
          if (this.contexts.get(key) === pending) this.contexts.delete(key);
          this.options.onContextClose?.(context);
        });
        for (const page of context.pages()) await page.close().catch(constVoid);
        if (this.closing) {
          await context.close().catch(constVoid);
          throw new Error("The preview browser is closed.");
        }
        return context;
      });
    this.contexts.set(key, pending);
    void pending.catch(() => {
      if (this.contexts.get(key) === pending) this.contexts.delete(key);
    });
    return pending;
  }

  debugEndpoint(context: BrowserContext) {
    return this.debugEndpoints.get(context);
  }

  private async createContext(profileId: string, isolationKey?: string, debug = false) {
    const contextOptions = { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 };
    if (debug) {
      await NodeFSP.mkdir(this.options.profilesDir, { recursive: true });
      const directory = await NodeFSP.mkdtemp(NodePath.join(this.options.profilesDir, "debug-"));
      this.debugDirectories.add(directory);
      let context: BrowserContext | undefined;
      try {
        const { executable, ...options } = await this.launchOptions();
        const { chromium } = loadPlaywright();
        context = await this.launch(executable, (executablePath) =>
          chromium.launchPersistentContext(directory, {
            ...options,
            ...contextOptions,
            args: [
              ...options.args,
              "--remote-debugging-address=127.0.0.1",
              "--remote-debugging-port=0",
            ],
            executablePath,
          }),
        );
        const port = Number(
          (await NodeFSP.readFile(NodePath.join(directory, "DevToolsActivePort"), "utf8")).split(
            "\n",
          )[0],
        );
        if (!Number.isInteger(port) || port < 1 || port > 65535)
          throw new Error("Chromium did not report a debug port");
        this.debugEndpoints.set(context, `http://127.0.0.1:${port}`);
        context.on("close", () => {
          const cleanup = Promise.resolve(context?.browser()?.close()).then(() =>
            NodeFSP.rm(directory, { recursive: true, force: true }),
          );
          this.debugCleanup.add(cleanup);
          void cleanup.finally(() => this.debugCleanup.delete(cleanup)).catch(constVoid);
        });
        return context;
      } catch (cause) {
        await context?.close().catch(constVoid);
        await NodeFSP.rm(directory, { recursive: true, force: true });
        throw cause;
      }
    }
    if (isolationKey !== undefined || profileId === INCOGNITO_BROWSER_PROFILE_ID) {
      return this.sharedContext(contextOptions);
    }
    const directory = this.profileDirectory(profileId);
    await NodeFSP.mkdir(directory, { recursive: true });
    const { executable, ...options } = await this.launchOptions();
    const { chromium } = loadPlaywright();
    return this.launch(executable, (executablePath) =>
      chromium.launchPersistentContext(directory, {
        ...options,
        ...contextOptions,
        executablePath,
      }),
    );
  }

  private profileDirectory(profileId: string) {
    const encoded = encodeURIComponent(profileId);
    return NodePath.join(
      this.options.profilesDir,
      profileId === "." || profileId === ".." ? encoded.replaceAll(".", "%2E") : encoded,
    );
  }

  async scratchPage() {
    if (this.closing) throw new Error("The preview browser is closed.");
    const context = await this.sharedContext();
    const page = await context.newPage();
    page.once("close", () => void context.close().catch(constVoid));
    return page;
  }

  async connectDesktopPage(endpoint: string) {
    const { chromium } = loadPlaywright();
    const browser = await chromium.connectOverCDP(endpoint, { timeout: 15_000 });
    const page = browser.contexts().flatMap((context) => context.pages())[0];
    if (!page) {
      await browser.close().catch(constVoid);
      throw new Error("The desktop tab has no page.");
    }
    return { browser, page };
  }

  async connectDebugPage(endpoint: string, url?: string) {
    const address = new URL(endpoint);
    if (
      address.protocol !== "http:" ||
      !["127.0.0.1", "localhost", "[::1]"].includes(address.hostname) ||
      !address.port ||
      address.username ||
      address.password ||
      address.pathname !== "/" ||
      address.search ||
      address.hash
    )
      throw new Error("The debug endpoint must be a loopback HTTP address with an explicit port.");
    const browser = await loadPlaywright().chromium.connectOverCDP(address.origin, {
      timeout: 5_000,
    });
    const pages = browser.contexts().flatMap((context) => context.pages());
    const matches = url ? pages.filter((page) => page.url() === url) : pages;
    if (matches.length !== 1) {
      await browser.close().catch(constVoid);
      throw new Error(
        matches.length
          ? "The IDE browser has multiple matching pages; close the extra pages before connecting."
          : "The IDE browser has no matching page; open the application in it first.",
      );
    }
    const page = matches[0]!;
    try {
      const session = await page.context().newCDPSession(page);
      try {
        const target = await session.send("Target.getTargetInfo");
        this.debugEndpoints.set(page.context(), address.origin);
        return { browser, page, id: target.targetInfo.targetId };
      } finally {
        await session.detach();
      }
    } catch (cause) {
      await browser.close().catch(constVoid);
      throw cause;
    }
  }

  async clearProfile(profileId: string) {
    if (profileId === INCOGNITO_BROWSER_PROFILE_ID) return;
    const key = JSON.stringify([profileId, null]);
    const existing = this.clearing.get(key);
    if (existing) return existing;
    const clearing = (async () => {
      const pending = this.contexts.get(key);
      if (pending) {
        this.contexts.delete(key);
        const context = await pending.catch(() => undefined);
        await context?.close();
      }
      await NodeFSP.rm(this.profileDirectory(profileId), { recursive: true, force: true });
    })();
    this.clearing.set(key, clearing);
    try {
      await clearing;
    } finally {
      if (this.clearing.get(key) === clearing) this.clearing.delete(key);
    }
  }

  close() {
    this.closing ??= this.dispose();
    return this.closing;
  }

  private async dispose() {
    clearTimeout(this.idleTimer);
    await Promise.allSettled(
      [...this.contexts.values()].map(async (pending) => (await pending).close()),
    );
    const browser = await this.browser?.catch(() => undefined);
    await browser?.close().catch(constVoid);
    await Promise.allSettled(this.debugCleanup);
    // Chromium may flush preferences after its context-close event.
    await Promise.allSettled(
      [...this.debugDirectories].map((directory) =>
        NodeFSP.rm(directory, { recursive: true, force: true }),
      ),
    );
    this.debugDirectories.clear();
    this.contexts.clear();
  }
}
