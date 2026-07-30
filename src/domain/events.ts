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
