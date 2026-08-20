import { Modal, Notice, setIcon, type App } from "obsidian";
import {
  cloneTaskDetailDraft,
  validateTaskDetailDraft,
  type TaskDetailAdapter,
  type TaskDetailCapabilities,
  type TaskDetailDraft,
  type TaskDetailPriority,
  type TaskDetailStatus,
  type TaskDetailSubtaskDraft,
} from "../domain/task-detail";

const STATUS_LABELS: Record<TaskDetailStatus, string> = {
  idea: "想法",
  active: "进行中",
  completed: "已完成",
  paused: "已暂停",
  terminated: "已终止",
};

const PRIORITY_LABELS: Record<TaskDetailPriority, string> = {
  0: "无优先级",
  1: "低",
  3: "中",
  5: "高",
};

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function localDateValue(value: Date): string {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export class UnifiedTaskDetailModal extends Modal {
  private draft: TaskDetailDraft | null = null;
  private capabilities: TaskDetailCapabilities | null = null;
  private saving = false;

  constructor(app: App, private readonly adapter: TaskDetailAdapter) {
    super(app);
  }

  onOpen(): void {
    this.setTitle("");
    this.modalEl.addClass("helix-task-editor-modal", "helix-unified-task-editor-modal");
    this.contentEl.addClass("helix-task-editor", "helix-unified-task-editor");
    this.contentEl.createDiv({ cls: "helix-task-editor-loading", text: "正在读取任务…" });
    void this.adapter.read()
      .then(({ draft, capabilities }) => {
        this.draft = cloneTaskDetailDraft(draft);
        this.capabilities = capabilities;
        this.renderEditor();
      })
      .catch((error) => {
        this.contentEl.empty();
        this.contentEl.createDiv({ cls: "helix-task-editor-load-error", text: messageOf(error) });
      });
  }

  private renderEditor(): void {
    const draft = this.draft;
    const capabilities = this.capabilities;
    if (!draft || !capabilities) return;
    this.contentEl.empty();

    const context = this.contentEl.createDiv({ cls: "helix-task-editor-context" });
    draft.breadcrumb.forEach((item, index) => {
      if (index > 0) context.createSpan({ cls: "helix-task-editor-context-separator", text: "/" });
      context.createSpan({ cls: "helix-task-editor-context-copy", text: item });
    });
    const sync = context.createSpan({ cls: "helix-task-editor-sync" });
    const syncIcon = sync.createSpan();
    setIcon(syncIcon, draft.source === "dida" ? "cloud" : "file-check-2");
    sync.createSpan({ text: draft.syncLabel });

    const title = this.contentEl.createEl("textarea", {
      cls: "helix-task-editor-title",
      attr: { rows: "1", "aria-label": "任务标题", placeholder: "任务标题" },
    });
    title.value = draft.title;
    title.disabled = !capabilities.editTitle;
    title.addEventListener("input", () => { draft.title = title.value; });

    const properties = this.contentEl.createDiv({ cls: "helix-task-editor-properties" });
    const property = (label: string, icon: string, cls = ""): HTMLElement => {
      const field = properties.createDiv({ cls: `helix-task-editor-property ${cls}`.trim() });
      const iconEl = field.createSpan({ cls: "helix-task-editor-property-icon" });
      setIcon(iconEl, icon);
      field.createSpan({ cls: "helix-task-editor-property-label", text: label });
      return field;
    };
    const statusField = property("状态", "circle-dot");
    const status = statusField.createEl("select", { attr: { "aria-label": "任务状态" } });
    for (const value of capabilities.statusOptions) {
      status.createEl("option", { value, text: STATUS_LABELS[value] });
    }
    status.value = draft.status;
    status.disabled = !capabilities.editStatus;
    status.addEventListener("change", () => { draft.status = status.value as TaskDetailStatus; });

    const priorityField = property("优先级", "flag");
    const priority = priorityField.createEl("select", { attr: { "aria-label": "优先级" } });
    for (const value of [0, 1, 3, 5] as const) {
      priority.createEl("option", { value: String(value), text: PRIORITY_LABELS[value] });
    }
    priority.value = String(draft.priority);
    priority.disabled = !capabilities.editPriority;
    priority.addEventListener("change", () => { draft.priority = Number(priority.value) as TaskDetailPriority; });

    this.renderDateProperty(property("日期", "calendar-days", "is-date"), draft, capabilities);
    this.renderTimeProperty(property("时间", "clock-3", "is-time"), draft, capabilities);

    const tagsField = property("标签", "tags", "is-tags");
    const tags = tagsField.createEl("input", {
      type: "text",
      value: draft.tags.join(" "),
      placeholder: "添加标签",
      attr: { "aria-label": "标签" },
    });
    tags.disabled = !capabilities.editTags;
    tags.addEventListener("input", () => {
      draft.tags = [...new Set(tags.value.split(/[\s,，]+/u).map((tag) => tag.trim()).filter(Boolean))];
    });

    this.renderSubtasks(draft, capabilities);
    if (capabilities.list || capabilities.reminder || capabilities.repeat) {
      this.renderMoreProperties(draft, capabilities);
    }
    this.renderFooter(title);
    globalThis.setTimeout(() => title.focus(), 0);
  }

  private renderDateProperty(
    field: HTMLElement,
    draft: TaskDetailDraft,
    capabilities: TaskDetailCapabilities,
  ): void {
    const picker = field.createEl("details", { cls: "helix-task-editor-date-picker" });
    const summary = picker.createEl("summary", { attr: { "aria-label": "选择任务日期" } });
    const valueEl = summary.createSpan({ cls: "helix-task-editor-date-value" });
    const chevron = summary.createSpan({ cls: "helix-task-editor-date-chevron" });
    setIcon(chevron, "chevron-down");
    const calendar = picker.createDiv({ cls: "helix-task-editor-calendar-popover" });
    let month = draft.date ? new Date(`${draft.date}T12:00:00`) : new Date();
    const sync = () => valueEl.setText(draft.date ? `${Number(draft.date.slice(5, 7))}月${Number(draft.date.slice(8, 10))}日` : "选择日期");
    const render = (): void => {
      calendar.empty();
      const head = calendar.createDiv({ cls: "helix-task-editor-calendar-header" });
      const previous = head.createEl("button", { attr: { "aria-label": "上个月" } });
      setIcon(previous, "chevron-left");
      head.createEl("strong", { text: `${month.getFullYear()} 年 ${month.getMonth() + 1} 月` });
      const next = head.createEl("button", { attr: { "aria-label": "下个月" } });
      setIcon(next, "chevron-right");
      const weekdays = calendar.createDiv({ cls: "helix-task-editor-calendar-weekdays" });
      for (const weekday of ["一", "二", "三", "四", "五", "六", "日"]) weekdays.createSpan({ text: weekday });
      const grid = calendar.createDiv({ cls: "helix-task-editor-calendar-grid" });
      const first = new Date(month.getFullYear(), month.getMonth(), 1, 12);
      const start = new Date(first);
      start.setDate(first.getDate() - ((first.getDay() + 6) % 7));
      const today = localDateValue(new Date());
      for (let index = 0; index < 42; index += 1) {
        const day = new Date(start);
        day.setDate(start.getDate() + index);
        const value = localDateValue(day);
        const button = grid.createEl("button", {
          cls: `helix-task-editor-calendar-day${day.getMonth() === month.getMonth() ? "" : " is-outside"}${value === today ? " is-today" : ""}${value === draft.date ? " is-selected" : ""}`,
          text: String(day.getDate()),
          attr: { "aria-label": value },
        });
        button.addEventListener("click", (event) => {
          event.preventDefault();
          draft.date = value;
          month = day;
          sync();
          picker.open = false;
        });
      }
      const footer = calendar.createDiv({ cls: "helix-task-editor-calendar-footer" });
      footer.createEl("button", { text: "清除" }).addEventListener("click", (event) => {
        event.preventDefault(); draft.date = ""; sync(); picker.open = false;
      });
      footer.createEl("button", { text: "今天" }).addEventListener("click", (event) => {
        event.preventDefault(); month = new Date(); draft.date = localDateValue(month); sync(); picker.open = false;
      });
      previous.addEventListener("click", (event) => { event.preventDefault(); month = new Date(month.getFullYear(), month.getMonth() - 1, 1, 12); render(); });
      next.addEventListener("click", (event) => { event.preventDefault(); month = new Date(month.getFullYear(), month.getMonth() + 1, 1, 12); render(); });
    };
    picker.addEventListener("toggle", () => { if (picker.open) render(); });
    if (!capabilities.editSchedule) picker.addClass("is-disabled");
    summary.addEventListener("click", (event) => { if (!capabilities.editSchedule) event.preventDefault(); });
    sync();
  }

  private renderTimeProperty(
    field: HTMLElement,
    draft: TaskDetailDraft,
    capabilities: TaskDetailCapabilities,
  ): void {
    const mode = field.createEl("select", { attr: { "aria-label": "时间类型" } });
    mode.createEl("option", { value: "none", text: "无时间" });
    mode.createEl("option", { value: "point", text: "时间点" });
    mode.createEl("option", { value: "range", text: "时间段" });
    mode.value = draft.timeMode;
    mode.disabled = !capabilities.editSchedule;
    const inputs = field.createDiv({ cls: "helix-task-editor-time-inputs" });
    const start = inputs.createEl("input", { type: "time", value: draft.startTime, attr: { "aria-label": "开始时间" } });
    const dash = inputs.createSpan({ text: "–" });
    const end = inputs.createEl("input", { type: "time", value: draft.endTime, attr: { "aria-label": "结束时间" } });
    start.disabled = !capabilities.editSchedule;
    end.disabled = !capabilities.editSchedule;
    const sync = (): void => {
      inputs.toggleClass("is-hidden", draft.timeMode === "none");
      dash.toggleClass("is-hidden", draft.timeMode !== "range");
      end.toggleClass("is-hidden", draft.timeMode !== "range");
    };
    mode.addEventListener("change", () => { draft.timeMode = mode.value as TaskDetailDraft["timeMode"]; sync(); });
    start.addEventListener("input", () => { draft.startTime = start.value; });
    end.addEventListener("input", () => { draft.endTime = end.value; });
    sync();
  }

  private renderSubtasks(draft: TaskDetailDraft, capabilities: TaskDetailCapabilities): void {
    const section = this.contentEl.createDiv({ cls: "helix-task-editor-subtasks" });
    const heading = section.createDiv({ cls: "helix-task-editor-section-head" });
    heading.createEl("strong", { text: "子任务" });
    const summary = heading.createSpan();
    const body = section.createDiv({ cls: "helix-task-editor-subtask-body" });
    const progress = body.createDiv({ cls: "helix-task-editor-progress" });
    const ring = progress.createDiv({ cls: "helix-task-editor-progress-ring", attr: { role: "progressbar", "aria-label": "子任务进度" } });
    const percentText = ring.createSpan();
    const countText = progress.createSpan({ cls: "helix-task-editor-progress-count" });
    const listWrap = body.createDiv({ cls: "helix-task-editor-subtask-list-wrap" });
    const list = listWrap.createDiv({ cls: "helix-task-editor-subtask-list" });
    let draggedIndex: number | null = null;
    const render = (): void => {
      list.empty();
      const completed = draft.subtasks.filter((child) => child.status === "completed").length;
      const percent = draft.subtasks.length ? Math.round(completed / draft.subtasks.length * 100) : 0;
      summary.setText(`${completed}/${draft.subtasks.length} 已完成`);
      ring.style.setProperty("--helix-task-progress", `${percent}%`);
      ring.setAttribute("aria-valuenow", String(percent));
      percentText.setText(`${percent}%`);
      countText.setText(`${completed} / ${draft.subtasks.length}`);
      draft.subtasks.forEach((child, index) => {
        const row = list.createDiv({ cls: "helix-task-editor-subtask" });
        const toggle = row.createEl("button", { cls: `helix-task-check${child.status === "completed" ? " is-completed" : ""}`, attr: { "aria-label": child.status === "completed" ? "重新打开子任务" : "完成子任务" } });
        if (child.status === "completed") setIcon(toggle, "check");
        toggle.disabled = !capabilities.editSubtasks;
        toggle.addEventListener("click", () => { child.status = child.status === "completed" ? "active" : "completed"; render(); });
        const title = row.createEl("input", { type: "text", value: child.title, attr: { "aria-label": `子任务 ${index + 1}` } });
        title.disabled = !capabilities.editSubtasks;
        title.addEventListener("input", () => { child.title = title.value; });
        const meta = row.createDiv({ cls: "helix-task-editor-subtask-meta" });
        if (child.date) meta.createSpan({ text: child.date.slice(5).replace("-", "/") });
        if (child.startTime) meta.createSpan({ text: child.endTime && child.endTime !== child.startTime ? `${child.startTime}–${child.endTime}` : child.startTime });
        if (child.priority) meta.createSpan({ cls: `is-priority-${child.priority}`, text: PRIORITY_LABELS[child.priority] });
        const grip = row.createSpan({ cls: "helix-task-editor-subtask-grip", attr: { draggable: String(capabilities.reorderSubtasks), "aria-label": "拖动排序" } });
        setIcon(grip, "grip-vertical");
        const more = row.createEl("details", { cls: "helix-task-editor-subtask-more" });
        const moreSummary = more.createEl("summary", { attr: { "aria-label": "更多子任务属性" } });
        setIcon(moreSummary, "ellipsis");
        const menu = more.createDiv({ cls: "helix-task-editor-subtask-menu" });
        const childDate = menu.createEl("input", { type: "date", value: child.date, attr: { "aria-label": "子任务日期" } });
        const childPriority = menu.createEl("select", { attr: { "aria-label": "子任务优先级" } });
        for (const value of [0, 1, 3, 5] as const) childPriority.createEl("option", { value: String(value), text: PRIORITY_LABELS[value] });
        childPriority.value = String(child.priority);
        const remove = menu.createEl("button", { cls: "helix-task-editor-subtask-remove", text: "删除子任务" });
        childDate.disabled = !capabilities.editSubtaskSchedule;
        childPriority.disabled = !capabilities.editSubtaskSchedule;
        remove.disabled = !capabilities.deleteSubtasks;
        childDate.addEventListener("change", () => { child.date = childDate.value; render(); });
        childPriority.addEventListener("change", () => { child.priority = Number(childPriority.value) as TaskDetailPriority; render(); });
        remove.addEventListener("click", () => { draft.subtasks.splice(index, 1); render(); });
        if (capabilities.reorderSubtasks) {
          grip.addEventListener("dragstart", () => { draggedIndex = index; row.addClass("is-dragging"); });
          grip.addEventListener("dragend", () => { draggedIndex = null; row.removeClass("is-dragging"); });
          row.addEventListener("dragover", (event) => { event.preventDefault(); row.addClass("is-drop-target"); });
          row.addEventListener("dragleave", () => row.removeClass("is-drop-target"));
          row.addEventListener("drop", (event) => {
            event.preventDefault(); row.removeClass("is-drop-target");
            if (draggedIndex === null || draggedIndex === index) return;
            const [moved] = draft.subtasks.splice(draggedIndex, 1);
            if (moved) draft.subtasks.splice(index, 0, moved);
            draggedIndex = null; render();
          });
        }
      });
    };
    render();
    if (capabilities.addSubtasks) {
      const add = listWrap.createDiv({ cls: "helix-task-editor-subtask-add" });
      const plus = add.createSpan(); setIcon(plus, "plus");
      const input = add.createEl("input", { type: "text", placeholder: "添加子任务", attr: { "aria-label": "添加子任务" } });
      input.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" || event.isComposing || !input.value.trim()) return;
        event.preventDefault();
        draft.subtasks.push({ id: `new:${crypto.randomUUID()}`, title: input.value.trim(), status: "idea", date: "", startTime: "", endTime: "", priority: 0 });
        input.value = ""; render(); input.focus();
      });
    }
  }

  private renderMoreProperties(draft: TaskDetailDraft, capabilities: TaskDetailCapabilities): void {
    const details = this.contentEl.createEl("details", { cls: "helix-task-editor-details helix-task-editor-more-properties" });
    const summary = details.createEl("summary");
    const icon = summary.createSpan(); setIcon(icon, "chevron-right");
    summary.createSpan({ text: "更多属性" });
    summary.createSpan({ cls: "helix-task-editor-summary-value", text: "清单 · 提醒 · 重复" });
    const body = details.createDiv({ cls: "helix-task-editor-details-body" });
    if (capabilities.list) {
      const row = body.createDiv({ cls: "helix-task-editor-extra-row" });
      row.createSpan({ text: "清单" });
      const list = row.createEl("select", { attr: { "aria-label": "滴答清单" } });
      for (const item of capabilities.listChoices) list.createEl("option", { value: item.id, text: item.name });
      list.value = draft.listId ?? "";
      list.addEventListener("change", () => { draft.listId = list.value; });
    }
    if (capabilities.reminder) {
      const row = body.createDiv({ cls: "helix-task-editor-extra-row" });
      row.createSpan({ text: "提醒" });
      const reminder = row.createEl("select", { attr: { "aria-label": "提醒" } });
      for (const [value, label] of [["", "无"], ["TRIGGER:PT0S", "任务时间"], ["TRIGGER:-PT10M", "提前 10 分钟"], ["TRIGGER:-PT1H", "提前 1 小时"], ["TRIGGER:-P1D", "提前 1 天"]]) reminder.createEl("option", { value, text: label });
      reminder.value = draft.reminders[0] ?? "";
      reminder.addEventListener("change", () => { draft.reminders = reminder.value ? [reminder.value] : []; });
    }
    if (capabilities.repeat) {
      const row = body.createDiv({ cls: "helix-task-editor-extra-row" });
      row.createSpan({ text: "重复" });
      const repeat = row.createEl("select", { attr: { "aria-label": "重复" } });
      for (const [value, label] of [["", "不重复"], ["RRULE:FREQ=DAILY;INTERVAL=1", "每天"], ["RRULE:FREQ=WEEKLY;INTERVAL=1", "每周"], ["RRULE:FREQ=MONTHLY;INTERVAL=1", "每月"], ["RRULE:FREQ=YEARLY;INTERVAL=1", "每年"]]) repeat.createEl("option", { value, text: label });
      repeat.value = draft.repeatFlag ?? "";
      repeat.addEventListener("change", () => { draft.repeatFlag = repeat.value || null; });
    }
  }

  private renderFooter(title: HTMLTextAreaElement): void {
    const capabilities = this.capabilities!;
    const footer = this.contentEl.createDiv({ cls: "helix-task-editor-footer" });
    if (capabilities.delete && this.adapter.delete) {
      const remove = footer.createEl("button", { cls: "helix-task-editor-delete" });
      const icon = remove.createSpan(); setIcon(icon, "trash-2");
      remove.createSpan({ text: "删除任务" });
      let armed = false;
      remove.addEventListener("click", () => {
        if (!armed) { armed = true; remove.addClass("is-armed"); new Notice("再次点击确认删除任务"); return; }
        remove.disabled = true;
        void this.adapter.delete!().then(() => this.close()).catch((error) => {
          armed = false; remove.disabled = false; remove.removeClass("is-armed"); new Notice(messageOf(error), 8_000);
        });
      });
    }
    footer.createDiv({ cls: "helix-task-editor-footer-spacer" });
    footer.createEl("button", { text: "取消" }).addEventListener("click", () => this.close());
    const save = footer.createEl("button", { cls: "mod-cta", text: "保存" });
    save.addEventListener("click", () => {
      if (this.saving || !this.draft) return;
      try { validateTaskDetailDraft(this.draft); } catch (error) { new Notice(messageOf(error)); title.focus(); return; }
      this.saving = true; save.disabled = true;
      void this.adapter.save(cloneTaskDetailDraft(this.draft)).then(() => this.close()).catch((error) => {
        this.saving = false; save.disabled = false; new Notice(messageOf(error), 8_000);
      });
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
