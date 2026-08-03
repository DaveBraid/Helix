export class TaskSubmissionGate {
  private writing = false;

  get isWriting(): boolean {
    return this.writing;
  }

  async run(operation: () => Promise<void>): Promise<boolean> {
    if (this.writing) return false;
    this.writing = true;
    try {
      await operation();
      return true;
    } finally {
      this.writing = false;
    }
  }
}

export type InlineTaskTitleKeyIntent = "commit" | "cancel" | null;

export function inlineTaskTitleKeyIntent(key: string): InlineTaskTitleKeyIntent {
  if (key === "Enter") return "commit";
  if (key === "Escape") return "cancel";
  return null;
}

export async function commitInlineTaskTitle(
  originalTitle: string,
  inputValue: string,
  save: (title: string) => Promise<void>,
): Promise<"unchanged" | "saved"> {
  const title = inputValue.trim();
  if (!title) throw new Error("任务标题不能为空");
  if (title === originalTitle) return "unchanged";
  await save(title);
  return "saved";
}
