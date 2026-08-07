import type { DidaChecklistItem } from "../../domain/entities";
import {
  DIDA_CHECKLIST_CLIENT_ID_MAX,
  DIDA_CHECKLIST_CLIENT_ID_MIN,
  isDidaChecklistClientId,
} from "../../domain/dida-checklist-id";

export function createDidaChecklistClientItem(
  baseline: DidaChecklistItem[],
  title: string,
  status: number,
  now: string,
  persistedId?: string,
): DidaChecklistItem {
  const ids = new Set<string>();
  for (const item of baseline) {
    if (!item.id || item.id !== item.id.trim() || /[\r\n]/u.test(item.id) || ids.has(item.id)) {
      throw new Error("检查项客户端 ID 分配基线无效");
    }
    ids.add(item.id);
  }
  let id = persistedId;
  if (id !== undefined) {
    if (!isDidaChecklistClientId(id) || ids.has(id)) throw new Error("持久化检查项客户端 ID 无效或碰撞");
  } else {
    const nowMs = Date.parse(now);
    const greatestExisting = [...ids].filter(isDidaChecklistClientId)
      .reduce((greatest, candidate) => Math.max(greatest, Number(candidate)), 0);
    const candidate = Math.max(nowMs, greatestExisting + 1);
    if (!Number.isSafeInteger(candidate) || candidate < DIDA_CHECKLIST_CLIENT_ID_MIN ||
      candidate > DIDA_CHECKLIST_CLIENT_ID_MAX) {
      throw new Error("无法生成 13 位检查项客户端 ID");
    }
    id = String(candidate);
  }
  let sortOrder = 0;
  if (baseline.length > 0) {
    if (baseline.some((item) => item.sortOrderUnsafe || !Number.isSafeInteger(item.sortOrder))) {
      throw new Error("远端检查项缺少可无损使用的 sortOrder，禁止追加");
    }
    sortOrder = Math.max(...baseline.map((item) => item.sortOrder!)) + 1;
    if (!Number.isSafeInteger(sortOrder)) throw new Error("检查项 sortOrder 无法安全递增");
  }
  return { id, title, status, sortOrder };
}

export function serializeDidaDate(
  value: string | null | undefined,
  label = "日期",
): string | null | undefined {
  if (value === null || value === undefined) return value;
  const parsed = new Date(value.replace(/([+-]\d{2})(\d{2})$/, "$1:$2"));
  if (Number.isNaN(parsed.getTime())) throw new Error(`Dida ${label}格式无效`);
  return parsed.toISOString().replace(/\.\d{3}Z$/, "+0000");
}

export function serializeDidaChecklistItems(
  items: DidaChecklistItem[] | undefined,
): DidaChecklistItem[] | undefined {
  // 与普通任务日期不同，items 采用完整数组替换合同，必须保留远端原始字面量与未知字段。
  return items?.map((item) => {
    if (item.sortOrderUnsafe) {
      throw new Error("检查项排序原值已丢失，禁止执行无法无损的整组回写");
    }
    const { sortOrderUnsafe: _legacyUnsafeMarker, ...raw } = item;
    if (raw.id === undefined || raw.id === "") {
      throw new Error("检查项写载荷缺少稳定 ID；必须先持久化客户端 ID");
    }
    return { ...raw };
  });
}
