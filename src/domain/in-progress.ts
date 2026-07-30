import type { InProgressEntry } from "./entities";
import { cloneValue } from "./stable";

export class InProgressRegistry {
  private entries: InProgressEntry[];

  constructor(initial: InProgressEntry[] = []) {
    this.entries = cloneValue(initial);
  }

  list(): InProgressEntry[] {
    return cloneValue(this.entries).sort(compareEntries);
  }

  top(limit = 3): InProgressEntry[] {
    return this.list().slice(0, limit);
  }

  mark(
    taskId: string,
    projectId: string,
    options: { cycleId?: string; now?: string } = {},
  ): InProgressEntry {
    const now = options.now ?? new Date().toISOString();
    const existing = this.entries.find((entry) => entry.taskId === taskId);
    if (existing) {
      existing.projectId = projectId;
      existing.cycleId = options.cycleId;
      existing.lastTouchedAt = now;
      return cloneValue(existing);
    }
    const entry: InProgressEntry = {
      taskId,
      projectId,
      cycleId: options.cycleId,
      markedAt: now,
      lastTouchedAt: now,
      activeFocus: false,
    };
    this.entries.push(entry);
    return cloneValue(entry);
  }

  unmark(taskId: string): void {
    this.entries = this.entries.filter((entry) => entry.taskId !== taskId);
  }

  touch(taskId: string, now = new Date().toISOString()): void {
    const entry = this.require(taskId);
    entry.lastTouchedAt = now;
  }

  setActiveFocus(taskId: string | null, now = new Date().toISOString()): void {
    for (const entry of this.entries) {
      entry.activeFocus = entry.taskId === taskId;
      if (entry.activeFocus) entry.lastTouchedAt = now;
    }
  }

  private require(taskId: string): InProgressEntry {
    const entry = this.entries.find((candidate) => candidate.taskId === taskId);
    if (!entry) throw new Error(`Task is not marked in progress: ${taskId}`);
    return entry;
  }
}

function compareEntries(left: InProgressEntry, right: InProgressEntry): number {
  if (left.activeFocus !== right.activeFocus) return left.activeFocus ? -1 : 1;
  return right.lastTouchedAt.localeCompare(left.lastTouchedAt);
}
