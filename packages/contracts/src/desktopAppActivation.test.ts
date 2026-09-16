import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  DesktopAppActivationRequest,
  DesktopAppActivationResponse,
} from "./desktopAppActivation.ts";

const isRequest = Schema.is(DesktopAppActivationRequest);
const isResponse = Schema.is(DesktopAppActivationResponse);

describe("desktop app activation protocol", () => {
  it("accepts both the original workspace request and a pairing request", () => {
    expect(
      isRequest({
        version: 1,
        requestId: "open-1",
        type: "open-workspace",
        workspaceRoot: "/workspace/project",
        platform: "linux",
      }),
    ).toBe(true);
    expect(
      isRequest({
        version: 1,
        requestId: "pair-1",
        type: "pair-environment",
        pairingUrl: "https://remote.example.test/pair#token=secret",
      }),
    ).toBe(true);
  });

  it("requires the pairing URL and accepts the pairing success shape", () => {
    expect(
      isRequest({
        version: 1,
        requestId: "pair-1",
        type: "pair-environment",
      }),
    ).toBe(false);
    expect(
      isResponse({
        version: 1,
        requestId: "pair-1",
        ok: true,
        type: "pair-environment",
        environmentId: "environment-paired",
      }),
    ).toBe(true);
  });
});
