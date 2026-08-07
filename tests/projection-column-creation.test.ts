import { describe, expect, it } from "vitest";
import type { DidaColumn, DidaProject } from "../src/domain/entities";
import { didaAuthorizationBinding } from "../src/domain/dida-authorization";
import { DIDA_CONTRACT_PROBE_VERSION } from "../src/domain/task-schedule";
import { stableHash } from "../src/domain/stable";
import { HelixService } from "../src/services/helix-service";
import { HelixDataStore } from "../src/storage/data-store";
import { createDefaultData } from "../src/storage/model";
import type { DidaRequestEmergencyLatch, HelixSecretStore } from "../src/storage/secrets";

describe("projection column creation", () => {
  it("requires a fresh double-confirmed preview and sends exactly one create", async () => {
    const harness = await createHarness();
    const preview = await harness.service.previewProjectionColumnCreation(harness.project.id);
    expect(preview).toMatchObject({ desiredName: "Helix项目", blockers: [] });
    const created = await harness.service.confirmProjectionColumnCreation(preview, preview.previewHash);
    expect(created).toMatchObject({ id: "column-created-1", name: "Helix项目" });
    expect(harness.control.createCalls).toBe(1);
    expect(harness.persisted().didaProjectionState?.columnCreation).toBeUndefined();
  });

  it("rejects a concurrent second confirmation while the first single send is running", async () => {
    const harness = await createHarness();
    let releaseCreate!: () => void;
    harness.control.createGate = new Promise<void>((resolve) => { releaseCreate = resolve; });
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    harness.control.onCreate = markStarted;
    const preview = await harness.service.previewProjectionColumnCreation(harness.project.id);
    const first = harness.service.confirmProjectionColumnCreation(preview, preview.previewHash);
    await started;
    await expect(harness.service.confirmProjectionColumnCreation(preview, preview.previewHash))
      .rejects.toThrow(/滴答项目同步分栏创建已经在运行/);
    await expect(harness.service.sync()).rejects.toThrow(/滴答项目同步分栏创建正在进行/);
    await expect(harness.service.runDidaWriteContractTest()).rejects.toThrow(/滴答项目同步分栏创建已经在运行/);
    await expect(harness.service.replaceDidaToken("replacement-token-12345"))
      .rejects.toThrow(/滴答项目同步分栏创建已经在运行/);
    expect(harness.control.createCalls).toBe(1);
    releaseCreate();
    await first;
    expect(harness.control.createCalls).toBe(1);
  });

  it("rejects a changed baseline and an expired capability before any create", async () => {
    const harness = await createHarness();
    const preview = await harness.service.previewProjectionColumnCreation(harness.project.id);
    harness.control.columns.push({ id: "concurrent", projectId: harness.project.id, name: "并发列" });
    await expect(harness.service.confirmProjectionColumnCreation(preview, preview.previewHash))
      .rejects.toThrow(/预览已经变化/);
    expect(harness.control.createCalls).toBe(0);

    const blocked = await createHarness(false);
    const blockedPreview = await blocked.service.previewProjectionColumnCreation(blocked.project.id);
    expect(blockedPreview.blockers).toContain("当前授权尚未通过分栏创建合同");
    await expect(blocked.service.confirmProjectionColumnCreation(blockedPreview, blockedPreview.previewHash))
      .rejects.toThrow(/分栏创建被阻止/);
    expect(blocked.control.createCalls).toBe(0);
  });

  it("blocks a different persisted projection target before checkpoint or remote write", async () => {
    const harness = await createHarness(true, undefined, "another-list");
    const preview = await harness.service.previewProjectionColumnCreation(harness.project.id);
    expect(preview.blockers.join(" ")).toMatch(/已绑定其他清单 another-list/);
    await expect(harness.service.confirmProjectionColumnCreation(preview, preview.previewHash))
      .rejects.toThrow(/分栏创建被阻止/);
    expect(harness.control.createCalls).toBe(0);
    expect(harness.persisted().didaProjectionState?.columnCreation).toBeUndefined();

    const sameTarget = await createHarness(true, undefined, "list-1");
    const allowed = await sameTarget.service.previewProjectionColumnCreation(sameTarget.project.id);
    expect(allowed.blockers).toEqual([]);
    await expect(sameTarget.service.confirmProjectionColumnCreation(allowed, allowed.previewHash))
      .resolves.toMatchObject({ name: "Helix项目" });
    expect(sameTarget.control.createCalls).toBe(1);
  });

  it("clears prepared when persisting running fails and returns the original error without sending", async () => {
    const harness = await createHarness();
    const preview = await harness.service.previewProjectionColumnCreation(harness.project.id);
    harness.control.failSaveCall = harness.control.saveCalls + 2;
    await expect(harness.service.confirmProjectionColumnCreation(preview, preview.previewHash))
      .rejects.toThrow(/persist running failed/);
    expect(harness.control.createCalls).toBe(0);
    expect(harness.persisted().didaProjectionState?.columnCreation).toBeUndefined();
    await expect(harness.service.previewProjectionColumnCreation(harness.project.id))
      .resolves.toMatchObject({ blockers: [] });
  });

  it("freezes an applied unknown outcome, never resends, and reconciles after restart", async () => {
    const harness = await createHarness();
    harness.control.createOutcome = "applied-unknown";
    const preview = await harness.service.previewProjectionColumnCreation(harness.project.id);
    await expect(harness.service.confirmProjectionColumnCreation(preview, preview.previewHash))
      .rejects.toThrow(/结果未知/);
    expect(harness.control.createCalls).toBe(1);
    expect(harness.persisted().didaProjectionState?.columnCreation).toMatchObject({ status: "unknown" });

    const restarted = await harness.restart();
    await expect(restarted.reconcileProjectionColumnCreation())
      .resolves.toMatchObject({ id: "column-created-1", name: "Helix项目" });
    expect(harness.control.createCalls).toBe(1);
    expect(harness.persisted().didaProjectionState?.columnCreation).toBeUndefined();
  });

  it("keeps an unknown checkpoint frozen when relative-baseline adoption is ambiguous", async () => {
    const harness = await createHarness();
    harness.control.createOutcome = "applied-unknown";
    const preview = await harness.service.previewProjectionColumnCreation(harness.project.id);
    await expect(harness.service.confirmProjectionColumnCreation(preview, preview.previewHash)).rejects.toThrow();
    harness.control.columns.push({ id: "concurrent", projectId: harness.project.id, name: "其他新列" });
    await expect(harness.service.reconcileProjectionColumnCreation()).rejects.toThrow(/唯一/);
    expect(harness.persisted().didaProjectionState?.columnCreation).toMatchObject({ status: "unknown" });
    expect(harness.control.createCalls).toBe(1);
  });

  it("clears prepared but converts running to unknown on startup without sending", async () => {
    const baselineColumns = [{ id: "todo", projectId: "list-1", name: "待处理" }];
    const prepared = await createHarness(true, {
      operationId: "projection-column:prepared-crash",
      targetProjectId: "list-1",
      desiredName: "Helix项目",
      baselineColumns,
      baselineHash: stableHash(baselineColumns),
      previewHash: "a".repeat(64),
      status: "prepared",
    });
    expect(prepared.persisted().didaProjectionState?.columnCreation).toBeUndefined();
    expect(prepared.control.createCalls).toBe(0);

    const running = await createHarness(true, {
      operationId: "projection-column:crash",
      targetProjectId: "list-1",
      desiredName: "Helix项目",
      baselineColumns,
      baselineHash: stableHash(baselineColumns),
      previewHash: "a".repeat(64),
      status: "running",
      remoteColumnId: "created-before-crash",
    });
    expect(running.persisted().didaProjectionState?.columnCreation).toMatchObject({
      status: "unknown",
      errorSummary: "插件在分栏创建收口前中断",
    });
    expect(running.control.createCalls).toBe(0);
  });

  it("blocks creation when the exact desired name already exists", async () => {
    const harness = await createHarness();
    harness.control.columns.push({ id: "existing", projectId: harness.project.id, name: "Helix项目" });
    const preview = await harness.service.previewProjectionColumnCreation(harness.project.id);
    expect(preview.blockers.join(" ")).toMatch(/已存在同名分栏/);
    await expect(harness.service.confirmProjectionColumnCreation(preview, preview.previewHash))
      .rejects.toThrow(/分栏创建被阻止/);
    expect(harness.control.createCalls).toBe(0);
  });
});

async function createHarness(
  columnCapability = true,
  checkpoint?: NonNullable<ReturnType<typeof createDefaultData>["didaProjectionState"]>["columnCreation"],
  persistedTargetProjectId?: string,
) {
  const initial = createDefaultData("projection-column-device");
  initial.didaContractCapabilities = {
    probeVersion: DIDA_CONTRACT_PROBE_VERSION,
    authorizationBinding: didaAuthorizationBinding("token"),
    taskScheduleMode: "duration",
    boardPlacementVerified: true,
    columnCreateVerified: columnCapability,
    taskCrudVerified: true,
    reminderWriteVerified: true,
    repeatWriteVerified: true,
    itemsRoundTripVerified: true,
    taskReopenVerified: true,
    verifiedAt: "2026-08-05T00:00:00.000Z",
  };
  if (checkpoint) {
    initial.didaProjectionState = {
      enabled: false,
      ledger: [],
      parentCheckpoints: [],
      columnCreation: checkpoint,
    };
  } else if (persistedTargetProjectId) {
    initial.didaProjectionState = {
      enabled: false,
      target: { targetProjectId: persistedTargetProjectId, targetColumnId: "existing-column" },
      ledger: [],
      parentCheckpoints: [],
    };
  }
  let persisted = structuredClone(initial);
  const project: DidaProject = { id: "list-1", name: "科研", viewMode: "kanban", permission: "write" };
  const control = {
    columns: [{ id: "todo", projectId: project.id, name: "待处理" }] as DidaColumn[],
    createCalls: 0,
    createOutcome: "success" as "success" | "applied-unknown",
    createGate: undefined as Promise<void> | undefined,
    onCreate: undefined as (() => void) | undefined,
    saveCalls: 0,
    failSaveCall: undefined as number | undefined,
  };
  let token = "token";
  let latch: DidaRequestEmergencyLatch | null = null;
  const port = {
    async loadData() { return structuredClone(persisted); },
    async saveData(value: unknown) {
      control.saveCalls += 1;
      if (control.saveCalls === control.failSaveCall) throw new Error("persist running failed");
      persisted = structuredClone(value) as typeof persisted;
    },
  };
  const api = {
    async getProject() { return { ...project }; },
    async getProjectData() { return { project: { ...project }, tasks: [], columns: structuredClone(control.columns) }; },
    async getColumns() { return structuredClone(control.columns); },
    async createColumn(projectId: string, value: { name: string }) {
      control.createCalls += 1;
      control.onCreate?.();
      await control.createGate;
      const created = { id: `column-created-${control.createCalls}`, projectId, name: value.name };
      control.columns.push(created);
      if (control.createOutcome === "applied-unknown") throw new Error("transport interrupted");
      return created;
    },
  };
  const makeService = async () => {
    const service = new HelixService(new HelixDataStore(port), {
      getDidaToken: () => token,
      setDidaToken: (value: string) => { token = value; },
      clearDidaToken: () => { token = ""; },
      setDidaRequestEmergencyLatch: (value: DidaRequestEmergencyLatch) => { latch = value; },
      clearDidaRequestEmergencyLatch: () => { latch = null; },
      getDidaRequestEmergencyLatch: () => latch,
    } as unknown as HelixSecretStore, { projectDidaProjectionAvailable: true });
    await service.initialize();
    Object.defineProperty(service, "api", { value: api });
    return service;
  };
  const service = await makeService();
  return {
    service,
    project,
    control,
    persisted: () => structuredClone(persisted),
    restart: makeService,
  };
}
