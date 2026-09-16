// @effect-diagnostics globalTimers:off -- The Node socket client owns its response deadline and clears it on every completion path.
import * as NodeCrypto from "node:crypto";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import type * as NodeStream from "node:stream";

import {
  DESKTOP_APP_ACTIVATION_PROTOCOL_VERSION,
  DesktopAppActivationErrorCode,
  DesktopAppActivationResponse,
  type DesktopAppActivationPlatform,
  type DesktopAppActivationRequest,
} from "@t3tools/contracts";
import { resolveDesktopAppControlAddress } from "@t3tools/shared/desktopAppControl";
import { resolveRemotePairingTarget } from "@t3tools/shared/remote";
import {
  HostProcessPlatform,
  HostProcessUserId,
  HostProcessWorkingDirectory,
} from "@t3tools/shared/hostProcess";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Argument, Command, Flag } from "effect/unstable/cli";

import { expandHomePath, resolveBaseDir } from "../os-jank.ts";
import { baseDirFlag } from "./config.ts";

const CLI_RESPONSE_TIMEOUT_MS = 17_000;
const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_PAIRING_URL_BYTES = 16 * 1024;
const isDesktopAppActivationResponse = Schema.is(DesktopAppActivationResponse);

export class DesktopAppSshUnsupportedError extends Schema.TaggedError<DesktopAppSshUnsupportedError>()(
  "DesktopAppSshUnsupportedError",
  {},
) {
  override get message(): string {
    return "`t3 app` only controls a desktop app on the same machine. It cannot run over SSH.";
  }
}

export class DesktopAppPlatformUnsupportedError extends Schema.TaggedError<DesktopAppPlatformUnsupportedError>()(
  "DesktopAppPlatformUnsupportedError",
  { platform: Schema.String },
) {
  override get message(): string {
    return `\`t3 app\` is not supported on ${this.platform}.`;
  }
}

export class DesktopAppUnreachableError extends Schema.TaggedError<DesktopAppUnreachableError>()(
  "DesktopAppUnreachableError",
  {
    candidateAddresses: Schema.Array(Schema.String),
    requestId: Schema.String,
    workspaceRoot: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Could not reach the T3 Code desktop app. Start or update the desktop app on this machine, then run `t3 app` again. A running T3 Code server is not enough.";
  }
}

export class DesktopAppRequestFailedError extends Schema.TaggedError<DesktopAppRequestFailedError>()(
  "DesktopAppRequestFailedError",
  {
    code: DesktopAppActivationErrorCode,
    requestId: Schema.String,
    workspaceRoot: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `T3 Code could not open ${this.workspaceRoot} (${this.code}).`;
  }
}

export class DesktopAppPairingInputError extends Schema.TaggedError<DesktopAppPairingInputError>()(
  "DesktopAppPairingInputError",
  {},
) {
  override get message(): string {
    return "Expected exactly one valid pairing URL on standard input.";
  }
}

export class DesktopAppPairingFailedError extends Schema.TaggedError<DesktopAppPairingFailedError>()(
  "DesktopAppPairingFailedError",
  {
    code: DesktopAppActivationErrorCode,
    requestId: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `T3 Code could not pair the environment (${this.code}).`;
  }
}

export async function readPairingUrlFromStdin(input: NodeStream.Readable): Promise<string> {
  let value = "";
  for await (const chunk of input) {
    value += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    if (Buffer.byteLength(value, "utf8") > MAX_PAIRING_URL_BYTES) {
      throw new DesktopAppPairingInputError({});
    }
  }

  const withoutTerminator = value.endsWith("\r\n")
    ? value.slice(0, -2)
    : value.endsWith("\n")
      ? value.slice(0, -1)
      : value;
  const pairingUrl = withoutTerminator.trim();
  if (
    pairingUrl.length === 0 ||
    withoutTerminator.includes("\n") ||
    withoutTerminator.includes("\r")
  ) {
    throw new DesktopAppPairingInputError({});
  }

  try {
    resolveRemotePairingTarget({ pairingUrl });
  } catch {
    throw new DesktopAppPairingInputError({});
  }
  return pairingUrl;
}

export const DesktopAppPairingUrlInput = Context.Reference<
  Effect.Effect<string, DesktopAppPairingInputError>
>("@t3tools/server/cli/app/DesktopAppPairingUrlInput", {
  defaultValue: () =>
    Effect.tryPromise({
      try: () => readPairingUrlFromStdin(process.stdin),
      catch: () => new DesktopAppPairingInputError({}),
    }),
});

function isDesktopPlatform(platform: NodeJS.Platform): platform is DesktopAppActivationPlatform {
  return platform === "darwin" || platform === "linux" || platform === "win32";
}

function sendDesktopAppActivationRequest(input: {
  readonly address: string;
  readonly fallbackAddress?: string;
  readonly request: DesktopAppActivationRequest;
  readonly timeoutMs?: number;
}): Promise<DesktopAppActivationResponse> {
  return new Promise((resolve, reject) => {
    const socket = NodeNet.createConnection(input.address);
    socket.setEncoding("utf8");
    let buffer = "";
    let settled = false;
    let connected = false;

    const finish = (
      result:
        | { readonly type: "success"; readonly response: DesktopAppActivationResponse }
        | { readonly type: "failure"; readonly error: Error },
    ) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.destroy();
      if (result.type === "success") resolve(result.response);
      else reject(result.error);
    };

    const timeout = setTimeout(() => {
      finish({
        type: "failure",
        error: new Error("The desktop app did not respond in time."),
      });
    }, input.timeoutMs ?? CLI_RESPONSE_TIMEOUT_MS);

    socket.once("connect", () => {
      connected = true;
      socket.write(`${JSON.stringify(input.request)}\n`);
    });
    socket.on("data", (chunk) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer, "utf8") > MAX_RESPONSE_BYTES) {
        finish({ type: "failure", error: new Error("The desktop app response is too large.") });
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;

      let parsed: unknown;
      try {
        parsed = JSON.parse(buffer.slice(0, newline));
      } catch {
        finish({
          type: "failure",
          error: new Error("The desktop app response is not valid JSON."),
        });
        return;
      }
      if (!isDesktopAppActivationResponse(parsed)) {
        finish({ type: "failure", error: new Error("The desktop app response is invalid.") });
        return;
      }
      if (parsed.requestId !== input.request.requestId) {
        finish({
          type: "failure",
          error: new Error("The desktop app response did not match this request."),
        });
        return;
      }
      finish({ type: "success", response: parsed });
    });
    socket.once("error", (error: NodeJS.ErrnoException) => {
      if (
        !settled &&
        !connected &&
        input.fallbackAddress !== undefined &&
        (error.code === "ENOENT" || error.code === "ECONNREFUSED")
      ) {
        settled = true;
        clearTimeout(timeout);
        socket.destroy();
        resolve(
          sendDesktopAppActivationRequest({
            address: input.fallbackAddress,
            request: input.request,
            ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
          }),
        );
        return;
      }
      finish({ type: "failure", error });
    });
    socket.once("end", () => {
      finish({ type: "failure", error: new Error("The desktop app closed the connection.") });
    });
  });
}

const appEnvironment = Config.all({
  t3Home: Config.string("T3CODE_HOME").pipe(Config.option, Config.map(Option.getOrUndefined)),
  sshConnection: Config.string("SSH_CONNECTION").pipe(Config.option),
  sshTty: Config.string("SSH_TTY").pipe(Config.option),
});

const runAppCommand = Effect.fn("cli.app")(function* (flags: {
  readonly baseDir: Option.Option<string>;
  readonly workspaceRoot: Option.Option<string>;
  readonly urlStdin: boolean;
}) {
  const environment = yield* appEnvironment;
  const hostPlatform = yield* HostProcessPlatform;
  if (Option.isSome(environment.sshConnection) || Option.isSome(environment.sshTty)) {
    return yield* new DesktopAppSshUnsupportedError({});
  }
  if (!isDesktopPlatform(hostPlatform)) {
    return yield* new DesktopAppPlatformUnsupportedError({ platform: hostPlatform });
  }

  const path = yield* Path.Path;
  const configuredBaseDir = Option.getOrUndefined(flags.baseDir) ?? environment.t3Home;
  const baseDir = yield* resolveBaseDir(configuredBaseDir);
  const allowDevFallback = Option.isNone(flags.baseDir) && !environment.t3Home?.trim();
  const userId = yield* HostProcessUserId;
  const resolveAddress = (stateSubdirectory: "userdata" | "dev") =>
    resolveDesktopAppControlAddress({
      stateDir: path.join(baseDir, stateSubdirectory),
      platform: hostPlatform,
      tempDir: NodeOS.tmpdir(),
      userId,
      joinPath: path.join,
    }).address;
  const pairFromStdin = flags.urlStdin && Option.getOrUndefined(flags.workspaceRoot) === "pair";
  if (flags.urlStdin && !pairFromStdin) {
    return yield* new DesktopAppPairingInputError({});
  }
  const pairingUrlInput = yield* DesktopAppPairingUrlInput;
  const request: DesktopAppActivationRequest = pairFromStdin
    ? {
        version: DESKTOP_APP_ACTIVATION_PROTOCOL_VERSION,
        requestId: NodeCrypto.randomUUID(),
        type: "pair-environment",
        pairingUrl: yield* pairingUrlInput,
      }
    : {
        version: DESKTOP_APP_ACTIVATION_PROTOCOL_VERSION,
        requestId: NodeCrypto.randomUUID(),
        type: "open-workspace",
        workspaceRoot: path.resolve(
          yield* expandHomePath(
            Option.getOrUndefined(flags.workspaceRoot) ?? (yield* HostProcessWorkingDirectory),
          ),
        ),
        platform: hostPlatform,
      };
  const address = resolveAddress("userdata");
  const fallbackAddress = allowDevFallback ? resolveAddress("dev") : undefined;

  const response = yield* Effect.tryPromise({
    try: () =>
      sendDesktopAppActivationRequest({
        address,
        ...(fallbackAddress === undefined ? {} : { fallbackAddress }),
        request,
      }),
    catch: (cause) =>
      new DesktopAppUnreachableError({
        candidateAddresses: fallbackAddress === undefined ? [address] : [address, fallbackAddress],
        requestId: request.requestId,
        workspaceRoot:
          request.type === "open-workspace" ? request.workspaceRoot : "pairing request",
        cause,
      }),
  });
  if (!response.ok) {
    if (request.type === "pair-environment") {
      return yield* new DesktopAppPairingFailedError({
        code: response.code,
        requestId: response.requestId,
        cause: response,
      });
    }
    return yield* new DesktopAppRequestFailedError({
      code: response.code,
      requestId: response.requestId,
      workspaceRoot: request.workspaceRoot,
      cause: response,
    });
  }

  if (request.type === "pair-environment") {
    if (!("environmentId" in response)) {
      return yield* new DesktopAppPairingFailedError({
        code: "internal-error",
        requestId: response.requestId,
        cause: new Error("The desktop app returned the wrong success response."),
      });
    }
    yield* Console.log("Paired environment in T3 Code.");
    return;
  }
  if (!("projectId" in response)) {
    return yield* new DesktopAppRequestFailedError({
      code: "internal-error",
      requestId: response.requestId,
      workspaceRoot: request.workspaceRoot,
      cause: new Error("The desktop app returned the wrong success response."),
    });
  }
  yield* Console.log(`Opened ${request.workspaceRoot} in T3 Code.`);
});

export const appCommand = Command.make("app", {
  baseDir: baseDirFlag,
  urlStdin: Flag.boolean("url-stdin").pipe(
    Flag.withDescription("Read one pairing URL from standard input. Use with the `pair` path."),
    Flag.withDefault(false),
  ),
  workspaceRoot: Argument.string("path").pipe(
    Argument.withDescription(
      "Project directory. Default: current directory. Use `pair --url-stdin` for secure pairing.",
    ),
    Argument.optional,
  ),
}).pipe(
  Command.withDescription("Open a project in the running T3 Code desktop app."),
  Command.withHandler(runAppCommand),
);
