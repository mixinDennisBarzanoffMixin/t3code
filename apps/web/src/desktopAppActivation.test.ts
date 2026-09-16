import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  handleDesktopAppActivationRequest,
  type DesktopAppActivationDependencies,
} from "./desktopAppActivation";

const environmentId = EnvironmentId.make("primary");
const existingProjectId = ProjectId.make("project-existing");
const createdProjectId = ProjectId.make("project-created");
const threadId = ThreadId.make("thread-1");
const request = {
  version: 1,
  requestId: "request-1",
  type: "open-workspace",
  workspaceRoot: "/workspace/project",
  platform: "linux",
} as const;

function dependencies(
  overrides: Partial<DesktopAppActivationDependencies> = {},
): DesktopAppActivationDependencies {
  return {
    getTarget: () => ({ environmentId, platform: "linux" }),
    findProject: () => ({
      id: existingProjectId,
      environmentId,
      workspaceRoot: request.workspaceRoot,
    }),
    createProject: vi.fn(async () => createdProjectId),
    waitForProject: vi.fn(async () => undefined),
    openThread: vi.fn(async () => ({ threadId })),
    registerPairing: vi.fn(async () => environmentId),
    ...overrides,
  };
}

describe("desktop app activation", () => {
  it("reuses an existing project and opens a new thread", async () => {
    const deps = dependencies();

    const response = await handleDesktopAppActivationRequest(request, deps);

    expect(deps.createProject).not.toHaveBeenCalled();
    expect(deps.openThread).toHaveBeenCalledWith({ environmentId, projectId: existingProjectId });
    expect(response).toEqual({
      version: 1,
      requestId: request.requestId,
      ok: true,
      projectId: existingProjectId,
      threadId,
    });
  });

  it("waits for a created project before it opens the thread", async () => {
    const order: string[] = [];
    const deps = dependencies({
      findProject: () => null,
      createProject: vi.fn(async () => {
        order.push("create");
        return createdProjectId;
      }),
      waitForProject: vi.fn(async () => {
        order.push("project-event");
      }),
      openThread: vi.fn(async () => {
        order.push("open-thread");
        return { threadId };
      }),
    });

    const response = await handleDesktopAppActivationRequest(request, deps);

    expect(order).toEqual(["create", "project-event", "open-thread"]);
    expect(response).toMatchObject({ ok: true, projectId: createdProjectId });
  });

  it("rejects a Windows path when the primary environment is WSL", async () => {
    const response = await handleDesktopAppActivationRequest(
      { ...request, platform: "win32" },
      dependencies({ getTarget: () => ({ environmentId, platform: "linux" }) }),
    );

    expect(response).toMatchObject({ ok: false, code: "platform-mismatch" });
  });

  it("returns a project error without opening a thread", async () => {
    const openThread = vi.fn(async () => ({ threadId }));
    const response = await handleDesktopAppActivationRequest(
      request,
      dependencies({
        findProject: () => null,
        createProject: vi.fn(async () => {
          throw new Error("Project path is not available.");
        }),
        openThread,
      }),
    );

    expect(response).toMatchObject({
      ok: false,
      code: "project-create-failed",
      message: "Project path is not available.",
    });
    expect(openThread).not.toHaveBeenCalled();
  });

  it("registers a pairing URL through the onboarding dependency", async () => {
    const pairingUrl = "https://remote.example.test/pair#token=one-time-secret";
    const registerPairing = vi.fn(async () => EnvironmentId.make("paired-environment"));

    const response = await handleDesktopAppActivationRequest(
      {
        version: 1,
        requestId: "request-pair",
        type: "pair-environment",
        pairingUrl,
      },
      dependencies({ registerPairing }),
    );

    expect(registerPairing).toHaveBeenCalledWith(pairingUrl);
    expect(response).toEqual({
      version: 1,
      requestId: "request-pair",
      ok: true,
      type: "pair-environment",
      environmentId: "paired-environment",
    });
  });

  it("returns a sanitized pairing failure", async () => {
    const pairingUrl = "https://remote.example.test/pair#token=one-time-secret";
    const response = await handleDesktopAppActivationRequest(
      {
        version: 1,
        requestId: "request-pair-failed",
        type: "pair-environment",
        pairingUrl,
      },
      dependencies({
        registerPairing: vi.fn(async () => {
          throw new Error(`Remote rejected ${pairingUrl}`);
        }),
      }),
    );

    expect(response).toMatchObject({ ok: false, code: "pairing-failed" });
    expect(JSON.stringify(response)).not.toContain("one-time-secret");
  });
});
