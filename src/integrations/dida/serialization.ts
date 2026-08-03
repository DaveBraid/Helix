import type { DidaChecklistItem } from "../../domain/entities";

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
  return items?.map((item) => {
    const { sortOrderUnsafe: _sortOrderUnsafe, ...value } = item;
    return {
      ...value,
      sortOrder: item.sortOrderUnsafe ? undefined : item.sortOrder,
      startDate: serializeDidaDate(item.startDate, "检查项开始日期") ?? undefined,
      completedTime:
        typeof item.completedTime === "string"
          ? serializeDidaDate(item.completedTime, "检查项完成日期") ?? undefined
          : item.completedTime,
    };
  });
}
