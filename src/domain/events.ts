import { localDateKeyFromInstant } from "./local-date";
import { stableHash } from "./stable";

export type HelixEventType =
  | "task-completed"
  | "task-reopened"
  | "habit-checkin"
  | "habit-unchecked"
  | "focus-completed"
  | "focus-deleted"
  | "review-closed"
  | "cycle-closed"
  | "challenge-completed";

export interface HelixEvent {
  id: string;
  type: HelixEventType;
  occurredAt: string;
  entityId: string;
  projectId?: string;
  cycleId?: string;
  occurrenceKey?: string;
  minutes?: number;
  difficulty?: 1 | 2 | 3 | 4 | 5;
  metadata?: Record<string, unknown>;
}

const EVENT_TYPES = new Set<HelixEventType>([
  "task-completed",
  "task-reopened",
  "habit-checkin",
  "habit-unchecked",
  "focus-completed",
  "focus-deleted",
  "review-closed",
  "cycle-closed",
  "challenge-completed",
]);

export function isHelixEvent(value: unknown): value is HelixEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const event = value as Record<string, unknown>;
  if (
    typeof event.id !== "string" ||
    typeof event.type !== "string" ||
    !EVENT_TYPES.has(event.type as HelixEventType) ||
    typeof event.entityId !== "string" ||
    typeof event.occurredAt !== "string" ||
    !Number.isFinite(Date.parse(event.occurredAt))
  ) {
    return false;
  }
  if (!optionalString(event.projectId) || !optionalString(event.cycleId) ||
    !optionalString(event.occurrenceKey)) return false;
  if (event.minutes !== undefined &&
    (typeof event.minutes !== "number" || !Number.isFinite(event.minutes) || event.minutes < 0)) {
    return false;
  }
  if (event.difficulty !== undefined &&
    (!Number.isInteger(event.difficulty) || Number(event.difficulty) < 1 || Number(event.difficulty) > 5)) {
    return false;
  }
  return event.metadata === undefined ||
    (!!event.metadata && typeof event.metadata === "object" && !Array.isArray(event.metadata));
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

export class EventLedger {
  private readonly events = new Map<string, HelixEvent>();
  private readonly identities = new Set<string>();

  constructor(initial: HelixEvent[] = []) {
    for (const event of initial) this.append(event);
  }

  append(event: HelixEvent): boolean {
    const identity = deterministicEventId(event);
    if (this.events.has(event.id) || this.identities.has(identity)) return false;
    this.events.set(event.id, structuredClone(event));
    this.identities.add(identity);
    return true;
  }

  /**
   * 专注记录是远端只读事实派生出的本地事件。同步覆盖到同一记录时，
   * 允许用相同确定性身份更新分钟数；绝不用于任务、挑战等不可变事件。
   */
  refreshDerivedFocusCompleted(event: HelixEvent): boolean {
    if (event.type !== "focus-completed") {
      throw new Error("仅允许刷新专注完成事件");
    }
    const existing = this.events.get(event.id);
    if (!existing) {
      if (event.id !== deterministicEventId(event)) {
        throw new Error("仅允许刷新具有确定性身份的专注完成事件");
      }
      return this.append(event);
    }
    if (
      existing.type !== "focus-completed" ||
      existing.entityId !== event.entityId ||
      existing.occurrenceKey !== event.occurrenceKey ||
      deterministicEventId(existing) !== event.id
    ) {
      return false;
    }
    if (typeof event.minutes !== "number" || !Number.isFinite(event.minutes) || event.minutes < 0) {
      return false;
    }
    if (existing.minutes === event.minutes) return false;
    // 只纠正远端派生分钟数；发生时间、归属和元数据仍以既有账本为准。
    this.events.set(event.id, { ...existing, minutes: event.minutes });
    return true;
  }

  list(): HelixEvent[] {
    return [...this.events.values()]
      .map((event) => structuredClone(event))
      .sort((left, right) => left.occurredAt.localeCompare(right.occurredAt));
  }

  byDate(date: string): HelixEvent[] {
    return this.list().filter((event) => localDateKeyFromInstant(event.occurredAt) === date);
  }
}

export function deterministicEventId(input: {
  type: HelixEventType;
  entityId: string;
  occurrenceKey?: string;
  occurredAt: string;
}): string {
  const identity = [
    input.type,
    input.entityId,
    input.occurrenceKey ?? localDateKeyFromInstant(input.occurredAt),
  ].join(":");
  return `evt-${stableHash(identity)}`;
}
