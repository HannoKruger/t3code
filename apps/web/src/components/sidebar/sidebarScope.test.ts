import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type ScopedProjectRef,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { derivePhysicalProjectKey } from "../../logicalProject";
import {
  buildSidebarProjectSnapshots,
  type SidebarProjectSnapshot,
} from "../../sidebarProjectGrouping";
import {
  filterSidebarScopeThreads,
  resolveSidebarScope,
  sidebarScopeIncludes,
  sidebarScopeMatchingProjectKeys,
  sidebarScopeProjectKeys,
  sidebarScopeSearchEnvironmentIds,
  type SidebarScopeFilter,
} from "./sidebarScope";

function makeGroup(
  projectKey: string,
  memberProjectRefs: readonly ScopedProjectRef[],
): SidebarProjectSnapshot {
  const representative = memberProjectRefs[0]!;
  return {
    id: representative.projectId,
    environmentId: representative.environmentId,
    title: projectKey,
    workspaceRoot: `/tmp/${projectKey}`,
    repositoryIdentity: null,
    defaultModelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    createdAt: "2026-03-09T10:00:00.000Z",
    updatedAt: "2026-03-09T10:00:00.000Z",
    scripts: [],
    projectKey,
    displayName: projectKey,
    groupedProjectCount: memberProjectRefs.length,
    environmentPresence: "local-only",
    allRemoteMembersAreDesktopLocal: false,
    allRemoteMembersAreWsl: false,
    memberProjects: [],
    memberProjectRefs,
    remoteEnvironmentLabels: [],
  };
}

const laptop = EnvironmentId.make("laptop");
const desk = EnvironmentId.make("desk");
const retired = EnvironmentId.make("retired");
const option = (environmentId: EnvironmentId) => ({
  environmentId,
  label: environmentId,
  machine: "laptop" as const,
  offline: false,
});
const items = [option(laptop), option(desk)];
const shared = makeGroup("github.com/example/shared", [
  { environmentId: laptop, projectId: ProjectId.make("shared-laptop") },
  { environmentId: desk, projectId: ProjectId.make("shared-desk") },
]);
const deskOnly = makeGroup("desk:/srv/tools", [
  { environmentId: desk, projectId: ProjectId.make("tools") },
]);
const groups = [shared, deskOnly];
const groupingSettings = {
  sidebarProjectGroupingMode: "repository" as const,
  sidebarProjectGroupingOverrides: {},
};
const resolve = (overrides: Partial<Parameters<typeof resolveSidebarScope>[0]>) =>
  resolveSidebarScope({
    environmentScopeId: null,
    projectScopeKey: null,
    environmentItems: items,
    projectGroups: groups,
    settings: groupingSettings,
    canClearMissingScope: true,
    ...overrides,
  });

describe("resolveSidebarScope", () => {
  it("narrows the folder menu to groups with a member on the scoped environment", () => {
    const scope = resolve({ environmentScopeId: laptop });

    expect(scope.environment).toBe(items[0]);
    expect(scope.projectGroups).toEqual([shared]);
    expect(scope.key).not.toBe(resolve({}).key);
  });

  it("hands back the input group array and null axes when nothing is scoped, so memos keyed on them stay stable", () => {
    const scope = resolve({});

    expect(scope.projectGroups).toBe(groups);
    expect(scope.environment).toBeNull();
    expect(scope.projectGroup).toBeNull();
    // A fresh group list must not turn an unscoped sidebar into a scoped one.
    const regrouped = resolve({ projectGroups: [...groups] });
    expect(regrouped.environment).toBeNull();
    expect(regrouped.projectGroup).toBeNull();
    expect(regrouped.key).toBe(scope.key);
  });

  it("reads a stored environment that is no longer a choice as all environments, cleared only once absence is proven", () => {
    const pending = resolve({ environmentScopeId: retired, canClearMissingScope: false });

    expect(pending.environment).toBeNull();
    expect(pending.projectGroups).toBe(groups);
    expect(
      pending.stored.environmentScopeId,
      "clearing before proof would wipe a scope mid cold start",
    ).toBe(retired);
    expect(resolve({ environmentScopeId: retired }).stored.environmentScopeId).toBeNull();
  });

  it("never keeps an active scope behind a hidden control: no items means null and cleared", () => {
    const scope = resolve({ environmentScopeId: laptop, environmentItems: [] });

    expect(scope.environment).toBeNull();
    expect(scope.stored.environmentScopeId).toBeNull();
  });

  it("keeps both stored values while both still resolve", () => {
    expect(
      resolve({ environmentScopeId: desk, projectScopeKey: deskOnly.projectKey }).stored,
    ).toEqual({ environmentScopeId: desk, projectScopeKey: deskOnly.projectKey });
  });

  it("keeps a project scope alive when its environment scope dies", () => {
    const scope = resolve({ environmentScopeId: retired, projectScopeKey: deskOnly.projectKey });

    expect(scope.projectGroup).toBe(deskOnly);
    expect(scope.stored.projectScopeKey).toBe(deskOnly.projectKey);
  });

  it("drops a project group with no member on the scoped environment, behind the same readiness gate", () => {
    const pending = resolve({
      environmentScopeId: laptop,
      projectScopeKey: deskOnly.projectKey,
      canClearMissingScope: false,
    });

    expect(pending.projectGroup).toBeNull();
    expect(
      pending.stored.projectScopeKey,
      "the scoped machine's snapshot may not have arrived yet",
    ).toBe(deskOnly.projectKey);
    expect(
      resolve({ environmentScopeId: laptop, projectScopeKey: deskOnly.projectKey }).stored
        .projectScopeKey,
    ).toBeNull();
  });

  it("migrates a physical scratch scope to its group within the scoped environment", () => {
    const scratchProject = (environmentId: EnvironmentId, workspaceRoot: string) => ({
      id: ProjectId.make(`scratch-${environmentId}`),
      environmentId,
      title: "No project",
      workspaceRoot,
      repositoryIdentity: null,
      defaultModelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
      createdAt: "2026-03-09T10:00:00.000Z",
      updatedAt: "2026-03-09T10:00:00.000Z",
      scripts: [],
      isScratch: true as const,
    });
    const deskScratch = scratchProject(desk, "/desk/scratch");
    const scratchGroups = buildSidebarProjectSnapshots({
      projects: [scratchProject(laptop, "/laptop/scratch"), deskScratch],
      groupScratchProjects: true,
      settings: groupingSettings,
      primaryEnvironmentId: laptop,
      resolveEnvironmentLabel: (environmentId) => environmentId,
    });
    const scope = resolve({
      environmentScopeId: desk,
      projectScopeKey: derivePhysicalProjectKey(deskScratch),
      projectGroups: scratchGroups,
      canClearMissingScope: false,
    });

    expect(scope.projectGroup).toBe(scratchGroups[0]);
    expect(scope.stored.projectScopeKey, "migration needs no proof of absence").toBe(
      scratchGroups[0]!.projectKey,
    );
  });

  it("keys on effective values so a dropped stored key does not reset paging or selection", () => {
    const unscoped = resolve({}).key;
    expect(resolve({ environmentScopeId: retired, projectScopeKey: "gone" }).key).toBe(unscoped);
    expect(resolve({ environmentScopeId: desk, projectScopeKey: shared.projectKey }).key).not.toBe(
      unscoped,
    );
  });

  it("never keys an environment whose id is a sentinel word the same as no scope", () => {
    const all = EnvironmentId.make("all");
    const scoped = resolve({
      environmentScopeId: all,
      environmentItems: [...items, option(all)],
    });
    expect(scoped.environment?.environmentId).toBe(all);
    expect(scoped.key).not.toBe(resolve({}).key);
  });
});

describe("sidebarScopeProjectKeys", () => {
  it("collects the physical keys of the scoped group's members on every machine", () => {
    expect(sidebarScopeProjectKeys(shared)).toEqual(
      new Set(["laptop:shared-laptop", "desk:shared-desk"]),
    );
  });

  it("is null, not an empty set, when no project is scoped", () => {
    expect(sidebarScopeProjectKeys(null)).toBeNull();
  });
});

describe("sidebarScopeIncludes", () => {
  const onLaptop = { environmentId: laptop, projectId: ProjectId.make("app") };
  const onDesk = { environmentId: desk, projectId: ProjectId.make("app") };
  const strayOnLaptop = { environmentId: laptop, projectId: ProjectId.make("scratch") };
  const appKeys = new Set(["laptop:app", "desk:app"]);
  const admitted = (filter: SidebarScopeFilter) =>
    [onLaptop, onDesk, strayOnLaptop].filter((ref) => sidebarScopeIncludes(filter, ref));

  it("admits everything when neither axis is set", () => {
    expect(admitted({ environmentId: null, projectKeys: null })).toEqual([
      onLaptop,
      onDesk,
      strayOnLaptop,
    ]);
  });

  it("admits any project on the scoped environment, even one the group list does not know yet", () => {
    expect(admitted({ environmentId: laptop, projectKeys: null })).toEqual([
      onLaptop,
      strayOnLaptop,
    ]);
  });

  it("admits the scoped group's members on every machine when only a project is set", () => {
    expect(admitted({ environmentId: null, projectKeys: appKeys })).toEqual([onLaptop, onDesk]);
  });

  it("requires both axes when both are set", () => {
    expect(admitted({ environmentId: laptop, projectKeys: appKeys })).toEqual([onLaptop]);
  });
});

type SidebarRosterThread = Parameters<typeof filterSidebarScopeThreads>[0][number];

describe("sidebarScopeMatchingProjectKeys", () => {
  const projects = [
    { environmentId: laptop, projectId: ProjectId.make("app") },
    { environmentId: desk, projectId: ProjectId.make("app") },
    { environmentId: laptop, projectId: ProjectId.make("scratch") },
  ];

  it("hides nothing when neither axis is set", () => {
    expect(
      sidebarScopeMatchingProjectKeys(projects, { environmentId: null, projectKeys: null }),
    ).toBeNull();
  });

  it("lists every project of the scoped environment, including ones no group knows", () => {
    expect(
      sidebarScopeMatchingProjectKeys(projects, { environmentId: laptop, projectKeys: null }),
    ).toEqual(new Set(["laptop:app", "laptop:scratch"]));
  });

  it("requires both axes when both are set", () => {
    expect(
      sidebarScopeMatchingProjectKeys(projects, {
        environmentId: laptop,
        projectKeys: new Set(["laptop:app", "desk:app"]),
      }),
    ).toEqual(new Set(["laptop:app"]));
  });
});

describe("filterSidebarScopeThreads", () => {
  const thread = (
    id: string,
    ref: ScopedProjectRef,
    overrides: { archivedAt?: string; subagent?: boolean } = {},
  ): SidebarRosterThread & { readonly id: string } => ({
    id,
    ...ref,
    archivedAt: overrides.archivedAt ?? null,
    lineage: {
      rootThreadId: ThreadId.make(id),
      parentThreadId: overrides.subagent ? ThreadId.make("parent") : null,
      relationshipToParent: overrides.subagent ? "subagent" : null,
    },
  });
  const app = (environmentId: EnvironmentId) => ({
    environmentId,
    projectId: ProjectId.make("app"),
  });
  const threads = [
    thread("laptop-root", app(laptop)),
    thread("desk-root", app(desk)),
    thread("laptop-archived", app(laptop), { archivedAt: "2026-03-09T10:00:00.000Z" }),
    thread("laptop-subagent", app(laptop), { subagent: true }),
  ];
  const visibleIds = (filter: SidebarScopeFilter) =>
    filterSidebarScopeThreads(threads, filter).map((visible) => visible.id);

  it("keeps the roster rule that hides archived and subagent threads when nothing is scoped", () => {
    expect(visibleIds({ environmentId: null, projectKeys: null })).toEqual([
      "laptop-root",
      "desk-root",
    ]);
  });

  it("narrows the roster to the scoped environment on top of the project scope", () => {
    expect(visibleIds({ environmentId: laptop, projectKeys: null })).toEqual(["laptop-root"]);
    expect(
      visibleIds({ environmentId: desk, projectKeys: new Set(["laptop:app", "desk:app"]) }),
    ).toEqual(["desk-root"]);
  });
});

describe("sidebarScopeSearchEnvironmentIds", () => {
  const connected = [laptop, desk];

  it("hands back the connected list itself when unscoped, so the search key stays stable", () => {
    expect(sidebarScopeSearchEnvironmentIds(connected, null)).toBe(connected);
  });

  it("fans out only to the scoped environment, and nowhere while it is disconnected", () => {
    expect(sidebarScopeSearchEnvironmentIds(connected, desk)).toEqual([desk]);
    expect(sidebarScopeSearchEnvironmentIds(connected, retired)).toEqual([]);
  });
});
