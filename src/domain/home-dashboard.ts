import { localDateKey } from "./local-date";

export const HOME_GREETINGS = {
  dawn: [
    "晨光已到，先完成最小的一步。",
    "新的一天，从一个清晰动作开始。",
    "先把注意力交给最重要的事。",
    "清晨适合把方向校准。",
    "慢慢启动，也是在前进。",
    "今天的第一步，值得认真对待。",
  ],
  morning: [
    "早上好，今天推进什么？",
    "上午好，先让关键任务落地。",
    "把最难的一件事放到前面。",
    "节奏已经开始，专注于下一步。",
    "今天可以稳稳地推进。",
    "给重要目标一段完整时间。",
  ],
  noon: [
    "中午好，给下午留一条清晰路径。",
    "上午的收获，正好接上下一步。",
    "短暂整理，再继续向前。",
    "现在适合复核优先级。",
    "把注意力收回到真正重要的事。",
    "午间停顿，也能让方向更清楚。",
  ],
  afternoon: [
    "下午好，把计划变成可见进展。",
    "继续推进，下一步已经足够。",
    "不必一次完成全部，先完成当前。",
    "让今天留下一个可靠产物。",
    "现在仍是深度推进的好时候。",
    "保持节奏，重要的事正在积累。",
  ],
  evening: [
    "傍晚好，收束今天最重要的推进。",
    "给今天一个有分量的结尾。",
    "整理成果，也是在为明天铺路。",
    "还有时间完成一个小闭环。",
    "把未完事项留成清晰的下一步。",
    "今天的努力，值得被看见。",
  ],
  night: [
    "夜晚好，温和地收尾就很好。",
    "今天不必完美，留下真实记录即可。",
    "把思绪放回纸面，明天会更轻松。",
    "现在适合复盘，而不是苛责自己。",
    "给自己一个安静的结束。",
    "完成今日收束，明天再继续。",
  ],
} as const;

export type HomeGreetingPeriod = keyof typeof HOME_GREETINGS;

export function homeGreeting(now: Date): string {
  const period = greetingPeriod(now.getHours());
  const options = HOME_GREETINGS[period];
  return options[greetingIndex(localDateKey(now), period, options.length)]!;
}

export function greetingPeriod(hour: number): HomeGreetingPeriod {
  if (hour < 5) return "night";
  if (hour < 8) return "dawn";
  if (hour < 12) return "morning";
  if (hour < 14) return "noon";
  if (hour < 18) return "afternoon";
  if (hour < 22) return "evening";
  return "night";
}

function greetingIndex(day: string, period: HomeGreetingPeriod, length: number): number {
  let hash = 0;
  for (const character of `${day}:${period}`) {
    hash = (Math.imul(hash, 31) + character.charCodeAt(0)) | 0;
  }
  return Math.abs(hash) % length;
}
