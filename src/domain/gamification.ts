import type { HelixEvent } from "./events";
import { localDateKey, localDateKeyFromInstant } from "./local-date";

export interface PlayerProgress {
  xp: number;
  level: number;
  currentLevelXp: number;
  nextLevelXp: number;
  badges: string[];
}

export interface ChallengeDefinition {
  id: string;
  title: string;
  description: string;
  metric: "focus-sessions" | "focus-minutes" | "tasks" | "reviews" | "active-days";
  target: number;
  rewardXp: number;
  period: "weekly" | "monthly";
  startsAt: string;
  endsAt: string;
}

const XP_BY_DIFFICULTY = [0, 10, 18, 30, 45, 65];

export function deriveProgress(events: HelixEvent[]): PlayerProgress {
  const completedOccurrences = new Map<string, number>();
  const focusOccurrences = new Map<string, number>();
  const rewardedChallenges = new Set<string>();
  let xp = 0;
  for (const event of [...events].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt))) {
    const occurrence = `${event.entityId}:${event.occurrenceKey ?? localDateKeyFromInstant(event.occurredAt)}`;
    if (event.type === "task-completed" && !completedOccurrences.has(occurrence)) {
      const reward = XP_BY_DIFFICULTY[event.difficulty ?? 2] ?? 18;
      completedOccurrences.set(occurrence, reward);
      xp += reward;
    } else if (event.type === "task-reopened") {
      const reward = completedOccurrences.get(occurrence) ?? 0;
      xp = Math.max(0, xp - reward);
      completedOccurrences.delete(occurrence);
    } else if (event.type === "habit-checkin") {
      xp += 6;
    } else if (event.type === "habit-unchecked") {
      xp = Math.max(0, xp - 6);
    } else if (event.type === "focus-completed") {
      if (!focusOccurrences.has(occurrence)) {
        const reward = Math.min(30, Math.floor(Math.max(0, event.minutes ?? 0) / 10) * 3);
        focusOccurrences.set(occurrence, reward);
        xp += reward;
      }
    } else if (event.type === "focus-deleted") {
      const reward = focusOccurrences.get(occurrence) ?? 0;
      xp = Math.max(0, xp - reward);
      focusOccurrences.delete(occurrence);
    } else if (event.type === "review-closed") {
      xp += 25;
    } else if (event.type === "cycle-closed") {
      xp += 80;
    } else if (event.type === "challenge-completed") {
      const definition = frozenChallengeFromEvent(event);
      if (
        definition &&
        !rewardedChallenges.has(event.entityId) &&
        challengeProgress(definition, events) >= definition.target
      ) {
        rewardedChallenges.add(event.entityId);
        xp += definition.rewardXp;
      }
    }
  }
  const level = levelForXp(xp);
  const levelStart = xpForLevel(level);
  const nextLevel = xpForLevel(level + 1);
  return {
    xp,
    level,
    currentLevelXp: xp - levelStart,
    nextLevelXp: nextLevel - levelStart,
    badges: deriveBadges(events),
  };
}

function frozenChallengeFromEvent(event: HelixEvent): ChallengeDefinition | null {
  const metadata = event.metadata;
  if (
    metadata?.ruleVersion !== 1 ||
    typeof metadata.title !== "string" ||
    !["focus-sessions", "focus-minutes", "tasks", "reviews", "active-days"].includes(
      String(metadata.metric),
    ) ||
    typeof metadata.target !== "number" ||
    !Number.isFinite(metadata.target) ||
    metadata.target <= 0 ||
    typeof metadata.rewardXp !== "number" ||
    !Number.isFinite(metadata.rewardXp) ||
    metadata.rewardXp < 0 ||
    !["weekly", "monthly"].includes(String(metadata.period)) ||
    typeof metadata.startsAt !== "string" ||
    !Number.isFinite(Date.parse(metadata.startsAt)) ||
    typeof metadata.endsAt !== "string" ||
    !Number.isFinite(Date.parse(metadata.endsAt)) ||
    metadata.startsAt > metadata.endsAt
  ) {
    return null;
  }
  return {
    id: event.entityId,
    title: metadata.title,
    description: metadata.title,
    metric: metadata.metric as ChallengeDefinition["metric"],
    target: metadata.target,
    rewardXp: metadata.rewardXp,
    period: metadata.period as ChallengeDefinition["period"],
    startsAt: metadata.startsAt,
    endsAt: metadata.endsAt,
  };
}

export function rotatingChallenges(date: Date): ChallengeDefinition[] {
  const weekStart = mondayOf(date);
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekEnd.getDate() + 6);
  const seed = Number(
    `${weekStart.getFullYear()}${String(isoWeekNumber(weekStart)).padStart(2, "0")}`,
  );
  const weeklyPool: Array<Omit<ChallengeDefinition, "id" | "startsAt" | "endsAt">> = [
    {
      title: "Deep Focus Sprint",
      description: "完成 12 个不少于 25 分钟的深度专注时段",
      metric: "focus-sessions",
      target: 12,
      rewardXp: 600,
      period: "weekly",
    },
    {
      title: "Evidence Week",
      description: "本周累计完成 8 个任务；任务重开会回收进度",
      metric: "tasks",
      target: 8,
      rewardXp: 520,
      period: "weekly",
    },
    {
      title: "Review Relay",
      description: "本周累计关闭 6 篇日、周、月或年复盘",
      metric: "reviews",
      target: 6,
      rewardXp: 480,
      period: "weekly",
    },
  ];
  const selected = weeklyPool[seed % weeklyPool.length] ?? weeklyPool[0]!;
  const monthStart = new Date(date.getFullYear(), date.getMonth(), 1);
  const monthEnd = new Date(date.getFullYear(), date.getMonth() + 1, 0);
  const monthSeed = date.getFullYear() * 12 + date.getMonth();
  const monthlyPool: Array<Omit<ChallengeDefinition, "id" | "startsAt" | "endsAt">> = [
    {
      title: "Research Momentum",
      description: "本月累计完成 40 个任务；任务重开会回收进度",
      metric: "tasks",
      target: 40,
      rewardXp: 1_800,
      period: "monthly",
    },
    {
      title: "Focus Reserve",
      description: "本月累计完成 1,200 分钟有效专注",
      metric: "focus-minutes",
      target: 1_200,
      rewardXp: 2_000,
      period: "monthly",
    },
    {
      title: "Review Rhythm",
      description: "本月完成 20 次周期复盘",
      metric: "reviews",
      target: 20,
      rewardXp: 1_600,
      period: "monthly",
    },
  ];
  const monthly = monthlyPool[monthSeed % monthlyPool.length] ?? monthlyPool[0]!;
  return [
    {
      ...selected,
      id: `weekly-${localDateKey(weekStart)}-${seed % weeklyPool.length}`,
      startsAt: weekStart.toISOString(),
      endsAt: endOfDay(weekEnd).toISOString(),
    },
    {
      ...monthly,
      id: `monthly-${localDateKey(monthStart).slice(0, 7)}-${monthSeed % monthlyPool.length}`,
      startsAt: monthStart.toISOString(),
      endsAt: endOfDay(monthEnd).toISOString(),
    },
  ];
}

export function challengeProgress(
  challenge: ChallengeDefinition,
  events: HelixEvent[],
): number {
  return challengeContributions(challenge, events)
    .reduce((sum, contribution) => sum + contribution.value, 0);
}

/** 历史领奖事件只在当前进度仍达标时才代表已领取，支持远端派生事实纠正。 */
export function challengeClaimed(
  challenge: ChallengeDefinition,
  events: HelixEvent[],
): boolean {
  return challengeProgress(challenge, events) >= challenge.target &&
    events.some((event) =>
      event.type === "challenge-completed" &&
      event.entityId === challenge.id &&
      event.occurrenceKey === challenge.id,
    );
}

export interface ChallengeContribution {
  label: string;
  occurredAt: string;
  entityId: string;
  value: number;
}

export function challengeContributions(
  challenge: ChallengeDefinition,
  events: HelixEvent[],
): ChallengeContribution[] {
  const ordered = [...events]
    .sort((left, right) => left.occurredAt.localeCompare(right.occurredAt));
  const inPeriod = ordered.filter(
    (event) => event.occurredAt >= challenge.startsAt && event.occurredAt <= challenge.endsAt,
  );
  const tasks = new Map<string, HelixEvent>();
  const focus = new Map<string, HelixEvent>();
  for (const event of ordered) {
    const occurrence = `${event.entityId}:${event.occurrenceKey ?? localDateKeyFromInstant(event.occurredAt)}`;
    const eventInPeriod =
      event.occurredAt >= challenge.startsAt && event.occurredAt <= challenge.endsAt;
    if (event.type === "task-completed" && eventInPeriod) tasks.set(occurrence, event);
    else if (event.type === "task-reopened") tasks.delete(occurrence);
    else if (event.type === "focus-completed" && eventInPeriod) {
      focus.set(occurrence, event);
    }
    else if (event.type === "focus-deleted") focus.delete(occurrence);
  }
  if (challenge.metric === "focus-sessions") {
    return [...focus.values()]
      .filter((event) => Math.max(0, event.minutes ?? 0) >= 25)
      .map((event) => ({
        label: "有效专注",
        occurredAt: event.occurredAt,
        entityId: event.entityId,
        value: 1,
      }));
  }
  if (challenge.metric === "focus-minutes") {
    return [...focus.values()].map((event) => ({
      label: "专注分钟",
      occurredAt: event.occurredAt,
      entityId: event.entityId,
      value: Math.max(0, event.minutes ?? 0),
    }));
  }
  if (challenge.metric === "tasks") {
    return [...tasks.values()].map((event) => ({
      label: "完成任务",
      occurredAt: event.occurredAt,
      entityId: event.entityId,
      value: 1,
    }));
  }
  if (challenge.metric === "reviews") {
    return inPeriod.filter((event) => event.type === "review-closed").map((event) => ({
      label: "关闭复盘",
      occurredAt: event.occurredAt,
      entityId: event.entityId,
      value: 1,
    }));
  }
  return [...new Map(inPeriod.map((event) => [
    localDateKeyFromInstant(event.occurredAt),
    event,
  ])).entries()].map(([date, event]) => ({
    label: "活跃日",
    occurredAt: event.occurredAt,
    entityId: date,
    value: 1,
  }));
}

function levelForXp(xp: number): number {
  let level = 1;
  while (xp >= xpForLevel(level + 1)) level += 1;
  return level;
}

function xpForLevel(level: number): number {
  return Math.floor(100 * (level - 1) ** 1.55);
}

function deriveBadges(events: HelixEvent[]): string[] {
  const badges: string[] = [];
  if (events.some((event) => event.type === "cycle-closed")) badges.push("完成首轮迭代");
  if (events.filter((event) => event.type === "review-closed").length >= 7) {
    badges.push("复盘节律");
  }
  const focus = new Map<string, number>();
  for (const event of [...events].sort((left, right) => left.occurredAt.localeCompare(right.occurredAt))) {
    const occurrence = `${event.entityId}:${event.occurrenceKey ?? localDateKeyFromInstant(event.occurredAt)}`;
    if (event.type === "focus-completed") focus.set(occurrence, Math.max(0, event.minutes ?? 0));
    else if (event.type === "focus-deleted") focus.delete(occurrence);
  }
  if ([...focus.values()].reduce((sum, minutes) => sum + minutes, 0) >= 1_000) {
    badges.push("千分钟专注");
  }
  return badges;
}

function mondayOf(date: Date): Date {
  const start = new Date(date);
  start.setHours(0, 0, 0, 0);
  const day = start.getDay() || 7;
  start.setDate(start.getDate() - day + 1);
  return start;
}

function endOfDay(date: Date): Date {
  const end = new Date(date);
  end.setHours(23, 59, 59, 999);
  return end;
}

function isoWeekNumber(date: Date): number {
  const utc = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const day = utc.getUTCDay() || 7;
  utc.setUTCDate(utc.getUTCDate() + 4 - day);
  const first = new Date(Date.UTC(utc.getUTCFullYear(), 0, 1));
  return Math.ceil(((utc.getTime() - first.getTime()) / 86_400_000 + 1) / 7);
}
