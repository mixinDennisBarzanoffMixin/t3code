import { describe, expect, it } from "vite-plus/test";

import { cliArchiveFileName, cliArchivePlatformKey, cliArchiveStem } from "./build-cli-archive.ts";

describe("CLI archive libc naming", () => {
  it("keeps glibc release names stable", () => {
    expect(cliArchivePlatformKey("linux", "x64")).toBe("linux-x64");
    expect(cliArchivePlatformKey("linux", "x64", "glibc")).toBe("linux-x64");
    expect(cliArchiveFileName("1.2.3", "linux", "x64", "glibc")).toBe("t3-1.2.3-linux-x64.tar.gz");
  });

  it("gives musl a distinct Linux release archive", () => {
    expect(cliArchivePlatformKey("linux", "x64", "musl")).toBe("linux-x64-musl");
    expect(cliArchiveStem("1.2.3", "linux", "x64", "musl")).toBe("t3-1.2.3-linux-x64-musl");
    expect(cliArchiveFileName("1.2.3", "linux", "x64", "musl")).toBe(
      "t3-1.2.3-linux-x64-musl.tar.gz",
    );
  });

  it("does not add a libc suffix to non-Linux archives", () => {
    expect(cliArchiveFileName("1.2.3", "mac", "arm64", "musl")).toBe(
      "t3-1.2.3-darwin-arm64.tar.gz",
    );
  });
});
