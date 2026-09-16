// @effect-diagnostics nodeBuiltinImport:off -- The integration fixture binds the same platform socket or named pipe as the CLI.
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeStream from "node:stream";
import * as NodeUtil from "node:util";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import type { DesktopAppActivationRequest } from "@t3tools/contracts";
import { resolveDesktopAppControlAddress } from "@t3tools/shared/desktopAppControl";
import {
  HostProcessPlatform,
  HostProcessUserId,
  HostProcessWorkingDirectory,
} from "@t3tools/shared/hostProcess";
import * as NetService from "@t3tools/shared/Net";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Command } from "effect/unstable/cli";
import { afterEach, describe, expect, vi } from "vite-plus/test";

import { makeCli } from "../bin.ts";
import {
  DesktopAppPairingInputError,
  DesktopAppPairingUrlInput,
  readPairingUrlFromStdin,
} from "./app.ts";

vi.mock("node:os", async (importOriginal) => {
  const os = await importOriginal<typeof import("node:os")>();
  return { ...os, homedir: vi.fn(os.homedir) };
});

afterEach(() => vi.mocked(NodeOS.homedir).mockReset());

const runCli = (args: ReadonlyArray<string>, env: Record<string, string> = {}) =>
  Command.runWith(makeCli(), { version: "0.0.0" })(args).pipe(
    Effect.provide(
      Layer.mergeAll(
        NodeServices.layer,
        NetService.layer,
        ConfigProvider.layer(ConfigProvider.fromEnv({ env })),
      ),
    ),
  );

const pathExists = (path: string) =>
  Effect.promise(() =>
    NodeFSP.stat(path).then(
      () => true,
      () => false,
    ),
  );

async function startFakeDesktop(input: {
  readonly baseDir: string;
  readonly stateSubdirectory?: "userdata" | "dev";
  readonly platform: NodeJS.Platform;
  readonly userId: number | undefined;
  readonly reply?: (request: DesktopAppActivationRequest) => unknown;
}) {
  const target = resolveDesktopAppControlAddress({
    stateDir: NodePath.join(input.baseDir, input.stateSubdirectory ?? "userdata"),
    platform: input.platform,
    tempDir: NodeOS.tmpdir(),
    userId: input.userId,
    joinPath: NodePath.join,
  });
  if (target.directory !== null) {
    await NodeFSP.mkdir(target.directory, { recursive: true, mode: 0o700 });
    await NodeFSP.unlink(target.address).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }

  const received: DesktopAppActivationRequest[] = [];
  const server = NodeNet.createServer((socket) => {
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      const request = JSON.parse(buffer.slice(0, newline)) as DesktopAppActivationRequest;
      received.push(request);
      const response = input.reply
        ? input.reply(request)
        : request.type === "pair-environment"
          ? {
              version: 1,
              requestId: request.requestId,
              ok: true,
              type: "pair-environment",
              environmentId: "environment-paired",
            }
          : {
              version: 1,
              requestId: request.requestId,
              ok: true,
              projectId: "project-1",
              threadId: `thread-${received.length}`,
            };
      socket.end(`${JSON.stringify(response)}\n`);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(target.address, resolve);
  });

  return {
    received,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (target.directory !== null) {
        await NodeFSP.unlink(target.address).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
        });
      }
    },
  };
}

const fakeDesktop = Effect.fn(function* (
  input: Omit<Parameters<typeof startFakeDesktop>[0], "platform" | "userId">,
) {
  const platform = yield* HostProcessPlatform;
  const userId = yield* HostProcessUserId;
  return yield* Effect.acquireRelease(
    Effect.promise(() => startFakeDesktop({ ...input, platform, userId })),
    (server) => Effect.promise(() => server.close()),
  );
});

const withTempDirectory = <A, E, R>(
  prefix: string,
  use: (root: string) => Effect.Effect<A, E, R>,
) =>
  Effect.acquireUseRelease(
    Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), prefix))),
    use,
    (root) => Effect.promise(() => NodeFSP.rm(root, { recursive: true, force: true })),
  );

describe("t3 app", () => {
  it("reads exactly one pairing URL without including invalid input in its error", async () => {
    const secret = "one-time-secret";
    await expect(
      readPairingUrlFromStdin(
        NodeStream.Readable.from([`https://remote.example.test/pair?token=${secret}\n`]),
      ),
    ).resolves.toBe(`https://remote.example.test/pair?token=${secret}`);
    await expect(
      readPairingUrlFromStdin(
        NodeStream.Readable.from([
          `https://remote.example.test/pair#token=${secret}\nsecond-line\n`,
        ]),
      ),
    ).rejects.toMatchObject({
      _tag: "DesktopAppPairingInputError",
      message: "Expected exactly one valid pairing URL on standard input.",
    });

    try {
      await readPairingUrlFromStdin(NodeStream.Readable.from([`not-a-url-${secret}\n`]));
      throw new Error("Expected pairing URL validation to fail.");
    } catch (error) {
      expect(error).toBeInstanceOf(DesktopAppPairingInputError);
      expect(String(error)).not.toContain(secret);
      expect(NodeUtil.inspect(error, { depth: 8 })).not.toContain(secret);
    }
  });

  it.effect("sends a stdin pairing URL to the desktop and prints only sanitized success", () =>
    withTempDirectory("t3-app-pair-test-", (root) =>
      Effect.gen(function* () {
        const baseDir = NodePath.join(root, "t3-home");
        const pairingUrl =
          "https://remote.example.test/pair#token=one-time-secret-never-print-this";
        const output: ReadonlyArray<unknown>[] = [];
        const testConsole = {
          ...globalThis.console,
          log: (...args: ReadonlyArray<unknown>) => output.push(args),
        } satisfies Console.Console;
        const desktop = yield* fakeDesktop({ baseDir });

        yield* runCli(["app", "pair", "--url-stdin", "--base-dir", baseDir]).pipe(
          Effect.provideService(DesktopAppPairingUrlInput, Effect.succeed(pairingUrl)),
          Effect.provideService(Console.Console, testConsole),
        );

        expect(desktop.received).toHaveLength(1);
        expect(desktop.received[0]).toMatchObject({ type: "pair-environment", pairingUrl });
        expect(output.flat().map(String).join("\n")).toBe("Paired environment in T3 Code.");
        expect(output.flat().map(String).join("\n")).not.toContain("one-time-secret");
      }).pipe(Effect.scoped),
    ),
  );

  it.effect("keeps a failed pairing URL out of CLI output and errors", () =>
    withTempDirectory("t3-app-pair-failure-test-", (root) =>
      Effect.gen(function* () {
        const baseDir = NodePath.join(root, "t3-home");
        const secret = "one-time-secret-never-report-this";
        const pairingUrl = `https://remote.example.test/pair#token=${secret}`;
        const output: ReadonlyArray<unknown>[] = [];
        const testConsole = {
          ...globalThis.console,
          log: (...args: ReadonlyArray<unknown>) => output.push(args),
          error: (...args: ReadonlyArray<unknown>) => output.push(args),
        } satisfies Console.Console;
        yield* fakeDesktop({
          baseDir,
          reply: (request) => ({
            version: 1,
            requestId: request.requestId,
            ok: false,
            code: "pairing-failed",
            message: "T3 Code could not pair the environment.",
          }),
        });

        const error = yield* runCli(["app", "pair", "--url-stdin", "--base-dir", baseDir]).pipe(
          Effect.provideService(DesktopAppPairingUrlInput, Effect.succeed(pairingUrl)),
          Effect.provideService(Console.Console, testConsole),
          Effect.flip,
        );

        expect(error).toMatchObject({ _tag: "DesktopAppPairingFailedError" });
        expect(String(error)).not.toContain(secret);
        expect(NodeUtil.inspect(error, { depth: 8 })).not.toContain(secret);
        expect(output.flat().map(String).join("\n")).not.toContain(secret);
      }).pipe(Effect.scoped),
    ),
  );

  it.effect("keeps `t3 app pair` as a workspace path without --url-stdin", () =>
    withTempDirectory("t3-app-pair-path-test-", (root) =>
      Effect.gen(function* () {
        const baseDir = NodePath.join(root, "t3-home");
        const desktop = yield* fakeDesktop({ baseDir });

        yield* runCli(["app", "pair", "--base-dir", baseDir]);

        expect(desktop.received).toHaveLength(1);
        expect(desktop.received[0]).toMatchObject({
          type: "open-workspace",
          workspaceRoot: NodePath.join(yield* HostProcessWorkingDirectory, "pair"),
        });
      }).pipe(Effect.scoped),
    ),
  );

  it.effect("rejects SSH before it tries to reach a desktop app", () =>
    withTempDirectory("t3-app-ssh-test-", (root) =>
      Effect.gen(function* () {
        const baseDir = NodePath.join(root, "missing-t3-home");
        const error = yield* runCli(["app", "--base-dir", baseDir], {
          SSH_CONNECTION: "client server",
        }).pipe(Effect.flip);

        expect(error).toMatchObject({
          _tag: "DesktopAppSshUnsupportedError",
          message:
            "`t3 app` only controls a desktop app on the same machine. It cannot run over SSH.",
        });
        expect(yield* pathExists(baseDir)).toBe(false);
      }),
    ),
  );

  it.effect("rejects unsupported platforms without creating state", () =>
    withTempDirectory("t3-app-platform-test-", (root) =>
      Effect.gen(function* () {
        const baseDir = NodePath.join(root, "missing-t3-home");
        const error = yield* runCli(["app", "--base-dir", baseDir]).pipe(
          Effect.provideService(HostProcessPlatform, "freebsd"),
          Effect.flip,
        );

        expect(error).toMatchObject({
          _tag: "DesktopAppPlatformUnsupportedError",
          platform: "freebsd",
          message: "`t3 app` is not supported on freebsd.",
        });
        expect(yield* pathExists(baseDir)).toBe(false);
      }),
    ),
  );

  it.effect("does not create state when only a server or no desktop app is running", () =>
    withTempDirectory("t3-app-missing-test-", (root) =>
      Effect.gen(function* () {
        const baseDir = NodePath.join(root, "missing-t3-home");
        const error = yield* runCli(["app", "--base-dir", baseDir]).pipe(Effect.flip);

        expect(error).toMatchObject({
          _tag: "DesktopAppUnreachableError",
          candidateAddresses: [expect.any(String)],
          workspaceRoot: yield* HostProcessWorkingDirectory,
          message: expect.stringContaining("Could not reach the T3 Code desktop app."),
          cause: { code: "ENOENT" },
        });
        expect(yield* pathExists(baseDir)).toBe(false);
      }),
    ),
  );

  it.effect("uses T3CODE_HOME or --base-dir and sends the default or explicit path", () =>
    withTempDirectory("t3-app-command-test-", (root) =>
      Effect.gen(function* () {
        const baseDir = NodePath.join(root, "t3-home");
        const explicitPath = NodePath.join(root, "project");
        const platform = yield* HostProcessPlatform;
        const workingDirectory = yield* HostProcessWorkingDirectory;
        const desktop = yield* fakeDesktop({ baseDir });

        yield* runCli(["app"], { T3CODE_HOME: baseDir });
        yield* runCli(["app", explicitPath, "--base-dir", baseDir]);

        const openRequests = desktop.received.filter(
          (request) => request.type === "open-workspace",
        );
        expect(openRequests.map((request) => request.workspaceRoot)).toEqual([
          workingDirectory,
          explicitPath,
        ]);
        expect(openRequests.every((request) => request.platform === platform)).toBe(true);
      }).pipe(Effect.scoped),
    ),
  );

  it.effect("prefers the installed desktop app when a dev desktop is also running", () =>
    withTempDirectory("t3-app-preferred-test-", (root) =>
      Effect.gen(function* () {
        vi.mocked(NodeOS.homedir).mockReturnValue(root);
        const baseDir = NodePath.join(root, ".t3");
        const desktop = yield* fakeDesktop({ baseDir });
        const development = yield* fakeDesktop({ baseDir, stateSubdirectory: "dev" });

        yield* runCli(["app"]);

        expect(desktop.received).toHaveLength(1);
        expect(development.received).toHaveLength(0);
      }).pipe(Effect.scoped),
    ),
  );

  it.effect("finds the dev desktop when the default desktop socket is absent", () =>
    withTempDirectory("t3-app-dev-test-", (root) =>
      Effect.gen(function* () {
        vi.mocked(NodeOS.homedir).mockReturnValue(root);
        const baseDir = NodePath.join(root, ".t3");
        const development = yield* fakeDesktop({ baseDir, stateSubdirectory: "dev" });

        yield* runCli(["app"]);
        yield* runCli(["app"], { T3CODE_HOME: "   " });

        expect(development.received).toHaveLength(2);
        expect(yield* pathExists(baseDir)).toBe(false);
      }).pipe(Effect.scoped),
    ),
  );

  it.effect("never searches a dev state directory for an explicit T3 home", () =>
    withTempDirectory("t3-app-explicit-test-", (root) =>
      Effect.gen(function* () {
        vi.mocked(NodeOS.homedir).mockReturnValue(root);
        const baseDir = NodePath.join(root, ".t3");
        const development = yield* fakeDesktop({ baseDir, stateSubdirectory: "dev" });

        const flagError = yield* runCli(["app", "--base-dir", baseDir]).pipe(Effect.flip);
        const envError = yield* runCli(["app"], { T3CODE_HOME: baseDir }).pipe(Effect.flip);

        expect(flagError).toMatchObject({ _tag: "DesktopAppUnreachableError" });
        expect(envError).toMatchObject({ _tag: "DesktopAppUnreachableError" });
        expect(development.received).toHaveLength(0);
      }).pipe(Effect.scoped),
    ),
  );

  for (const responseKind of ["failure", "invalid"] as const) {
    it.effect(`never falls back after the default desktop sends a ${responseKind} response`, () =>
      withTempDirectory("t3-app-response-test-", (root) =>
        Effect.gen(function* () {
          vi.mocked(NodeOS.homedir).mockReturnValue(root);
          const baseDir = NodePath.join(root, ".t3");
          const desktop = yield* fakeDesktop({
            baseDir,
            reply: (request) =>
              responseKind === "failure"
                ? {
                    version: 1,
                    requestId: request.requestId,
                    ok: false,
                    code: "project-create-failed",
                    message: "The project path is not available.",
                  }
                : { invalid: true },
          });
          const development = yield* fakeDesktop({ baseDir, stateSubdirectory: "dev" });

          const error = yield* runCli(["app"]).pipe(Effect.flip);

          expect(desktop.received).toHaveLength(1);
          expect(development.received).toHaveLength(0);
          if (responseKind === "failure") {
            expect(error).toMatchObject({
              _tag: "DesktopAppRequestFailedError",
              code: "project-create-failed",
              requestId: desktop.received[0]?.requestId,
              workspaceRoot: yield* HostProcessWorkingDirectory,
              message: expect.stringContaining("project-create-failed"),
              cause: {
                ok: false,
                code: "project-create-failed",
                message: "The project path is not available.",
              },
            });
          } else {
            expect(error).toMatchObject({
              _tag: "DesktopAppUnreachableError",
              cause: { message: "The desktop app response is invalid." },
            });
          }
        }).pipe(Effect.scoped),
      ),
    );
  }
});
