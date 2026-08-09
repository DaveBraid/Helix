import type { JournalPeriod } from "./entities";

export interface JournalTemplateInput {
  period: JournalPeriod;
  title: string;
  periodStart: string;
  periodEnd: string;
}

const QUESTIONS: Record<JournalPeriod, Array<[string, string]>> = {
  daily: [
    ["今日事实", "今天完成了什么、发生了什么？只写可验证事实。"],
    ["执行感受", "哪些任务顺畅或卡住？原因是什么？"],
    ["项目联系", "今天的证据改变了哪个项目或阶段？"],
    ["明日调整", "明天最重要的推进是什么？"],
  ],
  weekly: [
    ["本周产出", "本周最有价值的产物、决策和完成事项是什么？"],
    ["偏差复盘", "计划与实际差异最大在哪里？"],
    ["项目组合", "哪些项目应继续、暂停、结束或重新排序？"],
    ["下周策略", "下周的三个核心结果是什么？"],
  ],
  monthly: [
    ["月度证据", "哪些数据说明这个月正在向正确方向前进？"],
    ["系统问题", "有哪些反复出现的阻塞、过载或错误估计？"],
    ["资源重配", "时间和注意力应从哪里移向哪里？"],
    ["下月主题", "下个月只强调一个主题，它是什么？"],
  ],
  yearly: [
    ["年度成果", "今年真正改变长期轨迹的成果是什么？"],
    ["重要选择", "哪些选择最值得保留，哪些应停止？"],
    ["能力增长", "形成了哪些可复用能力和工作系统？"],
    ["下一年度", "下一年的方向、边界和首个阶段是什么？"],
  ],
};

const SUMMARY_START = "<!-- helix:summary:start -->";
const SUMMARY_END = "<!-- helix:summary:end -->";

/** 只替换 Helix 明确管理的摘要块；缺失或重复标记时拒绝猜测。 */
export function patchJournalSummary(markdown: string, summary: string): string {
  const start = markdown.indexOf(SUMMARY_START);
  const end = markdown.indexOf(SUMMARY_END);
  if (
    start < 0 || end < start ||
    markdown.indexOf(SUMMARY_START, start + SUMMARY_START.length) >= 0 ||
    markdown.indexOf(SUMMARY_END, end + SUMMARY_END.length) >= 0
  ) {
    throw new Error("复盘自动摘要标记缺失或重复，未修改正文");
  }
  const eol = markdown.includes("\r\n") ? "\r\n" : "\n";
  const normalized = summary.replace(/\r?\n/g, eol).trim();
  const replacement = `${SUMMARY_START}${eol}${normalized}${eol}${SUMMARY_END}`;
  const current = markdown.slice(start, end + SUMMARY_END.length);
  if (current === replacement) return markdown;
  return markdown.slice(0, start) + replacement + markdown.slice(end + SUMMARY_END.length);
}

export function journalTemplate(input: JournalTemplateInput, body?: string): string {
  const prompts = QUESTIONS[input.period]
    .map(([title, question]) => `> [!question] ${title}\n> ${question}\n`)
    .join("\n");
  return `---
helix-kind: helix-journal
helix-period: ${input.period}
helix-period-start: ${input.periodStart}
helix-period-end: ${input.periodEnd}
helix-status: open
helix-projects: []
---

# ${input.title}

## 自动摘要

<!-- helix:summary:start -->
Helix 将在这里维护任务、习惯、专注与项目数据摘要。
<!-- helix:summary:end -->

${body ?? `${prompts}## 自由记录

`}
`;
}

export function journalPath(
  root: string,
  period: JournalPeriod,
  date: Date,
): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  if (period === "daily") return `${root}/Journals/Daily/${year}-${month}-${day}.md`;
  if (period === "monthly") return `${root}/Journals/Monthly/${year}-${month}.md`;
  if (period === "yearly") return `${root}/Journals/Yearly/${year}.md`;
  const week = isoWeek(date);
  return `${root}/Journals/Weekly/${week.year}-W${week.week}.md`;
}

export function journalPeriodBounds(
  period: JournalPeriod,
  date: Date,
): { start: string; end: string } {
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const end = new Date(start);
  if (period === "weekly") {
    const weekday = start.getDay() || 7;
    start.setDate(start.getDate() - weekday + 1);
    end.setTime(start.getTime());
    end.setDate(end.getDate() + 6);
  } else if (period === "monthly") {
    start.setDate(1);
    end.setFullYear(start.getFullYear(), start.getMonth() + 1, 0);
  } else if (period === "yearly") {
    start.setMonth(0, 1);
    end.setFullYear(start.getFullYear(), 11, 31);
  }
  return { start: localDate(start), end: localDate(end) };
}

function isoWeek(date: Date): { year: number; week: string } {
  const utc = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const day = utc.getUTCDay() || 7;
  utc.setUTCDate(utc.getUTCDate() + 4 - day);
  const start = new Date(Date.UTC(utc.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((utc.getTime() - start.getTime()) / 86_400_000 + 1) / 7);
  return {
    year: utc.getUTCFullYear(),
    week: String(week).padStart(2, "0"),
  };
}

function localDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
