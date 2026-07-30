import { describe, expect, it } from "vitest";
import { aggregateAnalytics } from "../src/domain/analytics";
import { deterministicEventId, EventLedger, type HelixEvent } from "../src/domain/events";
import {
  challengeContributions,
  challengeProgress,
  deriveProgress,
  rotatingChallenges,
} from "../src/domain/gamification";
import { InProgressRegistry } from "../src/domain/in-progress";
import { journalPath, journalTemplate } from "../src/domain/journals";
import { localDateKeyFromInstant } from "../src/domain/local-date";
import { stableHash, stableStringify } from "../src/domain/stable";
import { createHash } from "node:crypto";

describe("in progress registry", () => {
  it("puts active focus first and limits the Today preview to three items", () => {
    const registry = new InProgressRegistry();
    for (let index = 1; index <= 4; index += 1) {
      registry.mark(`task-${index}`, `project-${index}`, {
        now: `2026-07-30T0${index}:00:00.000Z`,
      });
    }
    registry.setActiveFocus("task-1", "2026-07-30T09:00:00.000Z");
    expect(registry.top(3).map((entry) => entry.taskId)).toEqual([
      "task-1",
      "task-4",
      "task-3",
    ]);
    expect(registry.list()).toHaveLength(4);
  });
});

describe("journal templates", () => {
  it("creates structured daily prompts and deterministic paths", () => {
    const markdown = journalTemplate({
      period: "daily",
      title: "2026-07-30 日复盘",
      periodStart: "2026-07-30",
      periodEnd: "2026-07-30",
    });
    expect(markdown).toContain("> [!question] 今日事实");
    expect(markdown).toContain("<!-- helix:summary:start -->");
    expect(journalPath("Helix", "daily", new Date("2026-07-30T12:00:00Z"))).toBe(
      "Helix/Journals/Daily/2026-07-30.md",
    );
  });

  it("uses the ISO week-year at the Gregorian year boundary", () => {
    expect(journalPath("Helix", "weekly", new Date(2024, 0, 1))).toBe(
      "Helix/Journals/Weekly/2024-W01.md",
    );
    expect(journalPath("Helix", "weekly", new Date(2024, 11, 30))).toBe(
      "Helix/Journals/Weekly/2025-W01.md",
    );
  });
});

describe("event analytics and rewards", () => {
  it("deduplicates events and reverses task reward after reopening", () => {
    const completed: HelixEvent = {
      id: deterministicEventId({
        type: "task-completed",
        entityId: "task-1",
        occurrenceKey: "2026-07-30",
        occurredAt: "2026-07-30T10:00:00Z",
      }),
      type: "task-completed",
      entityId: "task-1",
      occurrenceKey: "2026-07-30",
      occurredAt: "2026-07-30T10:00:00Z",
      difficulty: 3,
    };
    const reopened: HelixEvent = {
      id: "evt-reopen",
      type: "task-reopened",
      entityId: "task-1",
      occurrenceKey: "2026-07-30",
      occurredAt: "2026-07-30T11:00:00Z",
    };
    const ledger = new EventLedger([completed]);
    expect(ledger.append(completed)).toBe(false);
    ledger.append(reopened);
    expect(deriveProgress(ledger.list()).xp).toBe(0);
    const analytics = aggregateAnalytics(ledger.list(), {
      from: "2026-07-30",
      to: "2026-07-30",
    });
    expect(analytics.totalTasks).toBe(0);
  });

  it("rotates a deterministic weekly challenge", () => {
    expect(rotatingChallenges(new Date("2026-07-30T12:00:00Z"))[0]).toEqual(
      rotatingChallenges(new Date("2026-08-01T12:00:00Z"))[0],
    );
    expect(rotatingChallenges(new Date("2026-07-15T12:00:00Z"))[1]).toEqual(
      rotatingChallenges(new Date("2026-07-30T12:00:00Z"))[1],
    );
  });

  it("reverses completion and habit credit on the original day even when reopened later", () => {
    const events: HelixEvent[] = [
      { id: "done", type: "task-completed", entityId: "task-1", occurrenceKey: "r1", occurredAt: "2026-07-29T23:00:00Z" },
      { id: "reopen", type: "task-reopened", entityId: "task-1", occurrenceKey: "r1", occurredAt: "2026-07-30T08:00:00Z" },
      { id: "habit", type: "habit-checkin", entityId: "habit-1", occurrenceKey: "2026-07-29", occurredAt: "2026-07-29T07:00:00Z" },
      { id: "uncheck", type: "habit-unchecked", entityId: "habit-1", occurrenceKey: "2026-07-29", occurredAt: "2026-07-30T07:00:00Z" },
    ];
    const analytics = aggregateAnalytics(events, { from: "2026-07-29", to: "2026-07-30" });
    expect(analytics.totalTasks).toBe(0);
    expect(analytics.totalHabitCheckins).toBe(0);
    expect(analytics.activeDays).toBe(0);
  });

  it("uses the local calendar day and reverses deleted focus credit", () => {
    expect(localDateKeyFromInstant(new Date(2026, 6, 30, 0, 30))).toBe("2026-07-30");
    const events: HelixEvent[] = [
      { id: "focus", type: "focus-completed", entityId: "focus-1", occurrenceKey: "focus-1", occurredAt: "2026-07-30T02:00:00Z", minutes: 50 },
      { id: "delete", type: "focus-deleted", entityId: "focus-1", occurrenceKey: "focus-1", occurredAt: "2026-07-30T03:00:00Z", minutes: 50 },
    ];
    expect(deriveProgress(events).xp).toBe(0);
    expect(aggregateAnalytics(events, { from: "2026-07-30", to: "2026-07-30" }).totalFocusMinutes).toBe(0);
    expect(challengeProgress({
      id: "focus-test",
      title: "Focus",
      description: "Focus",
      metric: "focus-minutes",
      target: 50,
      rewardXp: 10,
      period: "weekly",
      startsAt: "2026-07-30T00:00:00Z",
      endsAt: "2026-07-31T00:00:00Z",
    }, events)).toBe(0);
  });

  it("retracts a challenge reward when a qualifying task is reopened later", () => {
    let challenge = rotatingChallenges(new Date("2026-07-30T12:00:00Z"))[0]!;
    for (let offset = 0; challenge.metric !== "tasks"; offset += 7) {
      challenge = rotatingChallenges(new Date(2026, 6, 30 + offset))[0]!;
    }
    const completed: HelixEvent[] = Array.from(
      { length: challenge.target },
      (_, index) => ({
        id: `challenge-task-${index}`,
        type: "task-completed",
        entityId: `task-${index}`,
        occurrenceKey: "one",
        occurredAt: new Date(
          new Date(challenge.startsAt).getTime() + 3_600_000,
        ).toISOString(),
        difficulty: 1,
      }),
    );
    const award: HelixEvent = {
      id: "challenge-award",
      type: "challenge-completed",
      entityId: challenge.id,
      occurrenceKey: challenge.id,
      occurredAt: completed[0]!.occurredAt,
      metadata: {
        rewardXp: challenge.rewardXp,
        ruleVersion: 1,
        title: challenge.title,
        metric: challenge.metric,
        target: challenge.target,
        period: challenge.period,
        startsAt: challenge.startsAt,
        endsAt: challenge.endsAt,
      },
    };
    expect(deriveProgress([...completed, award]).xp).toBe(
      deriveProgress(completed).xp + challenge.rewardXp,
    );
    expect(deriveProgress([
      ...completed,
      award,
      {
        ...award,
        id: "duplicate-challenge-award",
        occurredAt: new Date(
          new Date(award.occurredAt).getTime() + 1_000,
        ).toISOString(),
      },
    ]).xp).toBe(deriveProgress(completed).xp + challenge.rewardXp);
    const reopened: HelixEvent = {
      id: "challenge-reopen",
      type: "task-reopened",
      entityId: "task-0",
      occurrenceKey: "one",
      occurredAt: new Date(
        new Date(challenge.endsAt).getTime() + 3_600_000,
      ).toISOString(),
    };
    expect(challengeProgress(challenge, [...completed, reopened])).toBe(
      challenge.target - 1,
    );
    expect(challengeContributions(challenge, [...completed, reopened])).toHaveLength(
      challenge.target - 1,
    );
    expect(deriveProgress([...completed, award, reopened]).xp).toBe(
      deriveProgress([...completed, reopened]).xp,
    );
  });

  it("projects reversals outside the requested month into the original heatmap", () => {
    const events: HelixEvent[] = [
      { id: "done", type: "task-completed", entityId: "task-1", occurrenceKey: "r1", occurredAt: "2026-07-30T08:00:00Z" },
      { id: "reopen", type: "task-reopened", entityId: "task-1", occurrenceKey: "r1", occurredAt: "2026-08-02T08:00:00Z" },
    ];
    expect(aggregateAnalytics(events, {
      from: "2026-07-01",
      to: "2026-07-31",
    }).totalTasks).toBe(0);
  });

  it("uses a deterministic full SHA-256 digest", () => {
    const value = { b: 2, a: ["x", 1] };
    expect(stableHash(value)).toBe(
      createHash("sha256").update(stableStringify(value)).digest("hex"),
    );
    expect(stableHash(value)).toHaveLength(64);
  });
});
