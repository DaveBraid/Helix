import { DIDA_CONTRACT_PROBE_VERSION } from "../domain/task-schedule";
import type { DidaWriteContractReport } from "../integrations/dida/write-contract";

export const DIDA_WEB_URL = "https://dida365.com/webapp/";
export const DIDA_TOKEN_MENU_PATH = "头像 → 设置 → 账户与安全 → API 口令";
export const DIDA_WRITE_CONTRACT_VERSION_LABEL = `合同版本 ${DIDA_CONTRACT_PROBE_VERSION}`;

/** 设置页与命令面板共用：合同报告中的远端正文、标记和 ID 一律不可见。 */
export function didaWriteContractSafeSummary(report: DidaWriteContractReport): string {
  const capabilities = report.capabilityFailures.length > 0
    ? "；部分扩展能力保持只读"
    : "";
  if (report.status === "passed" && !report.remoteArtifactsRemaining) {
    return `核心合同通过；测试对象已全部清理${capabilities}`;
  }
  const cleanup = report.remoteArtifactsRemaining || report.manualCleanupRequired
    ? "；存在待人工核对的专用测试对象，生产写入保持只读"
    : "；测试对象已安全清理";
  return `核心合同未通过；请查看脱敏合同状态${cleanup}${capabilities}`;
}

export const DIDA_WRITE_CONTRACT_SAFE_FAILURE = "无法运行写入合同测试；请查看脱敏合同状态。";
