// @effect-diagnostics globalTimers:off -- CDP callbacks run outside the Effect runtime.
import type { CDPSession } from "playwright-core";
import { ServerBrowserOperationError } from "./ServerBrowserPage.ts";

export class DebugBrowser {
  private readonly stopped = new Set<CDPSession>();
  private controller = new AbortController();

  readonly endpoint: string;

  constructor(endpoint: string) {
    this.endpoint = endpoint;
  }

  get paused() {
    return this.stopped.size > 0;
  }

  get signal() {
    return this.controller.signal;
  }

  async watch(session: CDPSession) {
    session.on("Debugger.paused", () => {
      this.stopped.add(session);
      this.controller.abort(
        new ServerBrowserOperationError({
          tag: "PreviewAutomationExecutionError",
          message:
            "Debug browser is paused in the IDE. Inspect or resume it there; the browser action may already have happened.",
        }),
      );
    });
    const resumed = () => {
      this.stopped.delete(session);
      if (!this.paused && this.controller.signal.aborted) this.controller = new AbortController();
    };
    session.on("Debugger.resumed", resumed);
    session.on("close", resumed);
    await session.send("Debugger.enable");
  }

  async run<A>(operation: () => Promise<A>): Promise<A> {
    const signal = this.signal;
    signal.throwIfAborted();
    let abort: () => void = () => {};
    const paused = new Promise<never>((_, reject) => {
      abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
    });
    try {
      return await Promise.race([operation(), paused]);
    } finally {
      signal.removeEventListener("abort", abort);
    }
  }
}
