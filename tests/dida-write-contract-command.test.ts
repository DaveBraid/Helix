import { describe, expect, it, vi } from "vitest";
import { DidaWriteContractConfirmationGate } from "../src/ui/dida-write-contract-confirmation";
import {
  DidaWriteContractCommandController,
  type DidaWriteContractCommandPort,
} from "../src/ui/dida-write-contract-command";

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason?: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function createHarness(run: DidaWriteContractCommandPort["run"]): {
  controller: DidaWriteContractCommandController;
  notices: string[];
  run: ReturnType<typeof vi.fn>;
} {
  const notices: string[] = [];
  const runSpy = vi.fn(run);
  const controller = new DidaWriteContractCommandController(
    new DidaWriteContractConfirmationGate(),
    {
      runtimeSummary: () => "合同版本 4；本次插件运行尚未执行合同测试",
      run: runSpy,
      notice: (message) => notices.push(message),
    },
  );
  return { controller, notices, run: runSpy };
}

describe("Dida write-contract command controller", () => {
  it("never places token or remote response text into notices when execution rejects", async () => {
    const secret = "token=secret-value; remote body=private-response";
    const { controller, notices } = createHarness(() => Promise.reject(new Error(secret)));

    controller.requestRun();
    controller.requestRun();
    await settle();

    expect(notices.join("\n")).not.toContain(secret);
    expect(notices.at(-1)).toBe("无法运行滴答写入合同测试；请查看合同状态与设置中的安全摘要。");
  });

  it("requires a second click from the command entry even when settings is armed", () => {
    const run = vi.fn(async () => ({ status: "passed" as const, remoteArtifactsRemaining: false }));
    const { controller, notices } = createHarness(run);
    const settingsGate = new DidaWriteContractConfirmationGate();

    expect(settingsGate.request()).toBe("armed");
    controller.requestRun();
    expect(run).not.toHaveBeenCalled();
    expect(notices.at(-1)).toContain("已武装");

    controller.requestRun();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("disarms the pending command confirmation on unload", () => {
    const { controller, run, notices } = createHarness(async () => ({
      status: "passed",
      remoteArtifactsRemaining: false,
    }));

    controller.requestRun();
    controller.dispose();
    controller.requestRun();

    expect(run).not.toHaveBeenCalled();
    expect(notices.filter((notice) => notice.includes("已武装"))).toHaveLength(1);
  });

  it("stays silent when an in-flight execution resolves after unload", async () => {
    const pending = deferred<{ status: "passed"; remoteArtifactsRemaining: boolean }>();
    const { controller, notices } = createHarness(() => pending.promise);

    controller.requestRun();
    controller.requestRun();
    const noticeCountBeforeDispose = notices.length;
    controller.dispose();
    controller.showStatus();
    controller.requestRun();
    pending.resolve({ status: "passed", remoteArtifactsRemaining: false });
    await settle();

    expect(notices).toHaveLength(noticeCountBeforeDispose);
  });

  it("stays silent when an in-flight execution rejects after unload", async () => {
    const pending = deferred<{ status: "passed"; remoteArtifactsRemaining: boolean }>();
    const { controller, notices } = createHarness(() => pending.promise);

    controller.requestRun();
    controller.requestRun();
    const noticeCountBeforeDispose = notices.length;
    controller.dispose();
    pending.reject(new Error("token=must-not-be-rendered"));
    await settle();

    expect(notices).toHaveLength(noticeCountBeforeDispose);
  });

  it("rejects concurrent and third requests until the running attempt settles", async () => {
    const pending = deferred<{ status: "passed"; remoteArtifactsRemaining: boolean }>();
    const { controller, run, notices } = createHarness(() => pending.promise);

    controller.requestRun();
    controller.requestRun();
    controller.requestRun();
    expect(run).toHaveBeenCalledTimes(1);
    expect(notices.at(-1)).toBe("滴答写入合同测试正在运行；已拒绝重复启动。");

    pending.resolve({ status: "passed", remoteArtifactsRemaining: false });
    await settle();
    controller.requestRun();
    expect(run).toHaveBeenCalledTimes(1);
    controller.requestRun();
    expect(run).toHaveBeenCalledTimes(2);
  });
});
