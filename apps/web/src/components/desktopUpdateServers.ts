import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import type {
  DesktopBridge,
  DesktopUpdateActionResult,
  DesktopUpdateState,
} from "@t3tools/contracts";

import { isDesktopLocalConnectionTarget } from "../connection/desktopLocal";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentPresentations } from "../state/presentation";
import { serverEnvironment } from "../state/server";
import {
  resolveServerSelfUpdateCapability,
  supportsServerUpdateThreadContinuation,
} from "../versionSkew";
import { getDesktopUpdateDownloadedVersion } from "./desktopUpdate.logic";
import {
  type ConnectedServer,
  type ServerUpdateBeforeInstall,
  serversToUpdateBeforeInstall,
} from "./desktopUpdateServers.logic";

/** The longest the app waits for one server to take its update before installing anyway. */
const SERVER_HANDOFF_TIMEOUT_MS = 3 * 60 * 1_000;

function connectedServers(): ReadonlyArray<ConnectedServer> {
  const presentations = appAtomRegistry.get(environmentPresentations.presentationsAtom);
  return [...presentations].map(([environmentId, presentation]) => ({
    environmentId,
    hostedByThisApp:
      presentation.entry.target._tag === "PrimaryConnectionTarget" ||
      isDesktopLocalConnectionTarget(presentation.entry.target),
    connected: presentation.entry.enabled && presentation.connection.phase === "connected",
    serverVersion: presentation.serverConfig?.environment.serverVersion ?? null,
    selfUpdate: resolveServerSelfUpdateCapability(presentation.serverConfig),
    threadContinuation: supportsServerUpdateThreadContinuation(presentation.serverConfig),
    updating:
      appAtomRegistry.get(serverEnvironment.updateStateAtom(environmentId)).status === "running",
  }));
}

/**
 * Starts one server's update and settles once the server has installed it and is about to
 * restart. The restart itself finishes on the server, so the app may quit from that point on.
 */
function updateServerUntilHandoff(target: ServerUpdateBeforeInstall): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    let unsubscribe = () => {};
    const finish = () => {
      if (settled) return;
      settled = true;
      globalThis.clearTimeout(timeout);
      unsubscribe();
      resolve();
    };
    const timeout = globalThis.setTimeout(finish, SERVER_HANDOFF_TIMEOUT_MS);
    unsubscribe = appAtomRegistry.subscribe(
      serverEnvironment.updateStateAtom(target.environmentId),
      (state) => {
        if (
          state.status === "failed" ||
          (state.status === "running" && state.stage === "resuming")
        ) {
          finish();
        }
      },
    );
    void runAtomCommand(appAtomRegistry, serverEnvironment.updateServer, target, {
      reportFailure: false,
    }).then(finish);
  });
}

/** Installs the downloaded app update after every connected server on an older version took it. */
export async function installDesktopUpdate(
  bridge: DesktopBridge,
  state: DesktopUpdateState | null,
): Promise<DesktopUpdateActionResult> {
  const targetVersion = state === null ? null : getDesktopUpdateDownloadedVersion(state);
  if (targetVersion !== null) {
    const targets = serversToUpdateBeforeInstall(connectedServers(), targetVersion);
    await Promise.all(targets.map(updateServerUntilHandoff));
  }
  return bridge.installUpdate();
}
