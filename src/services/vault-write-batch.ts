export interface ContentRevision {
  content: string;
}

export async function writeBatchWithRollback<TRevision extends ContentRevision>(
  plans: Array<{ revision: TRevision; content: string }>,
  write: (revision: TRevision, content: string) => Promise<TRevision>,
): Promise<void> {
  const written: Array<{ original: TRevision; current: TRevision }> = [];
  try {
    for (const plan of plans) {
      const current = await write(plan.revision, plan.content);
      written.push({ original: plan.revision, current });
    }
  } catch (error) {
    const rollbackErrors: string[] = [];
    for (const entry of written.reverse()) {
      try {
        await write(entry.current, entry.original.content);
      } catch (rollbackError) {
        rollbackErrors.push(
          rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
        );
      }
    }
    if (rollbackErrors.length > 0) {
      throw new Error(
        `项目谱系批量写入失败，且部分回滚失败：${rollbackErrors.join("；")}`,
        { cause: error },
      );
    }
    throw new Error("项目谱系批量写入发生竞争，已回滚本轮全部已写文件", {
      cause: error,
    });
  }
}
