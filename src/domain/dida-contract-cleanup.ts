import type { DidaColumn } from "./entities";

/**
 * 写入合同临时对象的恢复清单。它不是诊断数据：只可供受授权、逐项复读后的安全清理使用。
 */
export interface DidaContractCleanupPlan {
  runId: string;
  marker: string;
  projects: DidaContractCleanupProject[];
  tasks: DidaContractCleanupTask[];
}

export interface DidaContractCleanupProject {
  id: string;
  name: string;
  /** 删除前必须以双源完整复读匹配的列基线。 */
  expectedColumns: DidaColumn[];
  /** contract 为本次运行记录；adopted 为用户显式领养的旧残留。 */
  baselineSource: "contract" | "adopted";
  /** 请求结果未知时，只允许复读证明缺失，禁止再次发送删除。 */
  deleteState?: "sent-unknown";
}

export interface DidaContractCleanupTask {
  id: string;
  /** 只可在这些本轮临时清单中按精确身份定位。 */
  candidateProjectIds: string[];
  state: "open" | "completed" | "unknown";
  /** 请求结果未知时，只允许复读证明缺失，禁止再次发送删除。 */
  deleteState?: "sent-unknown";
}

/**
 * data.json 中的恢复门票。绑定只保存授权的域分离摘要，绝不含 API 密钥。
 */
export interface PendingDidaContractCleanup {
  authorizationBinding: string;
  plan: DidaContractCleanupPlan;
}

export const DIDA_CONTRACT_MARKER_PREFIX = "[Helix 合同测试 ";

export function didaContractMarker(runId: string): string {
  return `${DIDA_CONTRACT_MARKER_PREFIX}${runId}]`;
}

export function isDidaContractRunId(value: unknown): value is string {
  return typeof value === "string" && (
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value) ||
    /^run-[A-Za-z0-9][A-Za-z0-9-]{0,119}$/u.test(value)
  );
}

export function parseDidaContractProjectName(
  name: unknown,
): { runId: string; side: "A" | "B" } | null {
  if (typeof name !== "string") return null;
  const match = /^\[Helix 合同测试 ([^\]\r\n]+)\] 清单 ([AB])$/u.exec(name);
  if (!match || !isDidaContractRunId(match[1])) return null;
  return { runId: match[1], side: match[2] as "A" | "B" };
}

export function isDidaContractTaskTitle(title: unknown, marker: string): boolean {
  return typeof title === "string" && title.startsWith(`${marker} `);
}
