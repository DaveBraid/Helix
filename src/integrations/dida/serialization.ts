import type { DidaChecklistItem } from "../../domain/entities";

/** 由服务端分配 ID 的新检查项；运行时对象必须完全省略 id 属性。 */
export function newDidaChecklistItemDraft(title: string, status: number): DidaChecklistItem {
  return { title, status } as DidaChecklistItem;
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
    if (raw.id !== undefined) return { ...raw };
    const { id: _undefinedId, ...withoutId } = raw;
    return withoutId as DidaChecklistItem;
  });
}
