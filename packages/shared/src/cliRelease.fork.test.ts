import { describe, expect, it } from "vite-plus/test";

import { upstreamReleaseVersion } from "./cliRelease.ts";

describe("upstreamReleaseVersion", () => {
  it("drops the fork suffix", () => {
    expect(upstreamReleaseVersion("0.0.46-hanno.3")).toBe("0.0.46");
  });

  it("keeps upstream versions unchanged", () => {
    expect(upstreamReleaseVersion("0.0.46")).toBe("0.0.46");
    expect(upstreamReleaseVersion("0.0.46-nightly.20261010.2908")).toBe(
      "0.0.46-nightly.20261010.2908",
    );
  });
});
