import type {
  EnvironmentId,
  ServerSelfUpdateCapability,
  ServerSelfUpdateInput,
} from "@t3tools/contracts";
import { compareSemverVersions } from "@t3tools/shared/semver";

/** What deciding a server's update needs to know about one connected environment. */
export interface ConnectedServer {
  readonly environmentId: EnvironmentId;
  /** The app's own backends stop and restart with the app install itself. */
  readonly hostedByThisApp: boolean;
  readonly connected: boolean;
  readonly serverVersion: string | null;
  readonly selfUpdate: ServerSelfUpdateCapability | null;
  readonly threadContinuation: boolean;
  readonly updating: boolean;
}

export interface ServerUpdateBeforeInstall {
  readonly environmentId: EnvironmentId;
  readonly input: ServerSelfUpdateInput;
}

/**
 * The servers to bring to the app's new version before the app installs it, so app and servers
 * stay on one version. Only servers that update themselves through their background service are
 * included; servers run by another desktop app update with that app.
 */
export function serversToUpdateBeforeInstall(
  servers: Iterable<ConnectedServer>,
  targetVersion: string,
): ReadonlyArray<ServerUpdateBeforeInstall> {
  return [...servers].flatMap((server) =>
    !server.hostedByThisApp &&
    server.connected &&
    !server.updating &&
    server.selfUpdate === "boot-service" &&
    server.serverVersion !== null &&
    compareSemverVersions(server.serverVersion, targetVersion) < 0
      ? [
          {
            environmentId: server.environmentId,
            input: {
              targetVersion,
              ...(server.threadContinuation ? { continueRunningThreads: true } : {}),
            },
          },
        ]
      : [],
  );
}
