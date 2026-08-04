import { journalTemplate } from "../domain/journals";
import type { JournalPeriod } from "../domain/entities";
import type { HelixTemplateKind, HelixTemplateVariables } from "./template-manager";

const TEMPLATE_KIND: Record<JournalPeriod, HelixTemplateKind> = {
  daily: "daily-review",
  weekly: "weekly-review",
  monthly: "monthly-review",
  yearly: "yearly-review",
};

export async function createJournalDocument(input: {
  period: JournalPeriod;
  title: string;
  periodStart: string;
  periodEnd: string;
  generatedSummary: string;
  renderTemplate: (kind: HelixTemplateKind, values: HelixTemplateVariables) => Promise<string>;
}): Promise<string> {
  const userBody = await input.renderTemplate(TEMPLATE_KIND[input.period], {
    title: input.title,
    date: input.periodStart,
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
  });
  return journalTemplate({
    period: input.period,
    title: input.title,
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
  }, userBody).replace(
    "Helix 将在这里维护任务、习惯、专注与项目数据摘要。",
    input.generatedSummary,
  );
}
