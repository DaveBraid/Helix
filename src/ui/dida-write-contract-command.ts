import { DidaWriteContractConfirmationGate } from "./dida-write-contract-confirmation";

export interface DidaWriteContractCommandPort {
  runtimeSummary(): string;
  run(): Promise<{ status: "passed" | "failed"; remoteArtifactsRemaining: boolean }>;
  notice(message: string, timeout?: number): void;
}

/** 命令面板的安全外壳：只给出固定提示，绝不把异常正文送进 Notice。 */
export class DidaWriteContractCommandController {
  private running = false;
  private disposed = false;

  constructor(
    private readonly gate: DidaWriteContractConfirmationGate,
    private readonly port: DidaWriteContractCommandPort,
  ) {}

  showStatus(): void {
    if (this.disposed) return;
    this.port.notice(this.port.runtimeSummary(), 12_000);
  }

  requestRun(): void {
    if (this.disposed) return;
    if (this.running) {
      this.port.notice("滴答写入合同测试正在运行；已拒绝重复启动。", 8_000);
      return;
    }
    if (this.gate.request() === "armed") {
      this.port.notice("已武装：请在 15 秒内再次运行此命令，才会创建并清理专用测试对象。", 10_000);
      return;
    }
    this.running = true;
    void this.port.run()
      .then((report) => {
        if (this.disposed) return;
        this.port.notice(
          report.status === "passed" && !report.remoteArtifactsRemaining
            ? "滴答写入合同测试完成；请在设置中查看能力结果。"
            : "滴答写入合同测试未通过；请在设置中查看安全摘要。",
          12_000,
        );
      })
      .catch(() => {
        if (this.disposed) return;
        this.port.notice("无法运行滴答写入合同测试；请查看合同状态与设置中的安全摘要。", 12_000);
      })
      .finally(() => {
        if (!this.disposed) this.running = false;
      });
  }

  dispose(): void {
    this.disposed = true;
    this.gate.disarm();
  }
}
