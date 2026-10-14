import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { type ConnectedServer, serversToUpdateBeforeInstall } from "./desktopUpdateServers.logic";

const server = (overrides: Partial<ConnectedServer> = {}): ConnectedServer => ({
  environmentId: EnvironmentId.make("hulk"),
  hostedByThisApp: false,
  connected: true,
  serverVersion: "0.0.45-hanno.2",
  selfUpdate: "boot-service",
  threadContinuation: true,
  updating: false,
  ...overrides,
});

describe("serversToUpdateBeforeInstall", () => {
  it("updates an older background-service server to the app's new version", () => {
    expect(serversToUpdateBeforeInstall([server()], "0.0.45-hanno.3")).toEqual([
      {
        environmentId: "hulk",
        input: { targetVersion: "0.0.45-hanno.3", continueRunningThreads: true },
      },
    ]);
  });

  it("leaves servers already on that version or newer alone", () => {
    expect(serversToUpdateBeforeInstall([server()], "0.0.45-hanno.2")).toEqual([]);
    expect(
      serversToUpdateBeforeInstall([server({ serverVersion: "0.0.46-hanno.1" })], "0.0.45-hanno.3"),
    ).toEqual([]);
  });

  it("skips servers the app restarts itself, disconnected servers and running updates", () => {
    expect(
      serversToUpdateBeforeInstall(
        [
          server({ hostedByThisApp: true }),
          server({ connected: false }),
          server({ updating: true }),
        ],
        "0.0.45-hanno.3",
      ),
    ).toEqual([]);
  });

  it("skips servers that cannot update themselves in the background", () => {
    expect(
      serversToUpdateBeforeInstall(
        [server({ selfUpdate: "desktop-managed" }), server({ selfUpdate: null })],
        "0.0.45-hanno.3",
      ),
    ).toEqual([]);
  });

  it("only asks servers that support it to continue running threads", () => {
    expect(
      serversToUpdateBeforeInstall([server({ threadContinuation: false })], "0.0.45-hanno.3"),
    ).toEqual([{ environmentId: "hulk", input: { targetVersion: "0.0.45-hanno.3" } }]);
  });
});
