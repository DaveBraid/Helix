/** 编辑弹窗只提交用户实际改动；projectId 仅供迁移上下文使用，绝不进入普通更新载荷。 */
export function taskEditWriteFields(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  dirty: { reminders: boolean; repeatFlag: boolean },
): string[] {
  const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
  const fields = [
    "title", "content", "startDate", "dueDate", "isAllDay", "timeZone", "priority", "tags",
  ].filter((field) => !same(before[field], after[field]));
  if (dirty.reminders) fields.push("reminders");
  if (dirty.repeatFlag) fields.push("repeatFlag");
  return fields;
}
