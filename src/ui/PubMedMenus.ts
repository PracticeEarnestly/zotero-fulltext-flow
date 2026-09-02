import { PLUGIN_NAME, PREF_PREFIX } from "../config";
import { PubMedQA, type IdentifierCompletionResult, type MetadataValidationResult, type MetadataReplacementPreview } from "../core/PubMedQA";

export class PubMedMenus {
  private windows = new Set<any>();

  register(win: any) {
    if (this.windows.has(win)) return;
    this.windows.add(win);
    this.registerItemMenu(win);
    this.registerToolsMenu(win);
  }

  unregister(win: any) {
    const doc = win.document;
    for (const id of [
      "fulltextflow-pubmed-item-sep",
      "fulltextflow-pubmed-complete-ids",
      "fulltextflow-pubmed-validate",
      "fulltextflow-pubmed-replace",
      "fulltextflow-pubmed-tools-auto",
      "fulltextflow-pubmed-tools-email"
    ]) doc.getElementById(id)?.remove();
    this.windows.delete(win);
  }

  unregisterAll() { for (const win of Array.from(this.windows)) this.unregister(win); }

  private registerItemMenu(win: any) {
    const popup = win.document.getElementById("zotero-itemmenu");
    if (!popup) return;

    const sep = win.document.createXULElement("menuseparator");
    sep.id = "fulltextflow-pubmed-item-sep";

    const complete = win.document.createXULElement("menuitem");
    complete.id = "fulltextflow-pubmed-complete-ids";
    complete.setAttribute("label", "FullTextFlow：补全 PMID/PMCID");
    complete.addEventListener("command", () => void this.completeSelected(win));

    const validate = win.document.createXULElement("menuitem");
    validate.id = "fulltextflow-pubmed-validate";
    validate.setAttribute("label", "FullTextFlow：PubMed 校验 metadata（不修改）");
    validate.addEventListener("command", () => void this.validateSelected(win));

    const replace = win.document.createXULElement("menuitem");
    replace.id = "fulltextflow-pubmed-replace";
    replace.setAttribute("label", "FullTextFlow：PubMed 校验并替换 metadata…");
    replace.addEventListener("command", () => void this.replaceSelected(win));

    popup.append(sep, complete, validate, replace);
  }

  private registerToolsMenu(win: any) {
    const popup = win.document.getElementById("menu_ToolsPopup");
    if (!popup) return;

    const auto = win.document.createXULElement("menuitem");
    auto.id = "fulltextflow-pubmed-tools-auto";
    auto.setAttribute("type", "checkbox");
    auto.setAttribute("label", "FullTextFlow 自动补 PMID/PMCID");
    auto.setAttribute("checked", this.autoEnabled() ? "true" : "false");
    auto.addEventListener("command", () => {
      const enabled = !this.autoEnabled();
      Zotero.Prefs.set(`${PREF_PREFIX}.pubmedAutoIdentifiers`, enabled);
      auto.setAttribute("checked", enabled ? "true" : "false");
      Services.prompt.alert(
        win,
        PLUGIN_NAME,
        enabled
          ? "已开启 PMID/PMCID 自动补全。仅使用 DOI 或已有 PMID 进行精确匹配，不使用标题模糊匹配。"
          : "已关闭 PMID/PMCID 自动补全。右键手动补全仍可使用。"
      );
    });

    const email = win.document.createXULElement("menuitem");
    email.id = "fulltextflow-pubmed-tools-email";
    email.setAttribute("label", "FullTextFlow NCBI 联系邮箱");
    email.addEventListener("command", () => this.configureNCBIEmail(win));

    popup.append(auto, email);
  }

  private selectedItems(win: any): any[] {
    return (win.ZoteroPane?.getSelectedItems?.() || []).filter((item: any) => item?.isRegularItem?.());
  }

  private async completeSelected(win: any) {
    const items = this.selectedItems(win);
    if (!items.length) {
      Services.prompt.alert(win, PLUGIN_NAME, "请先选择至少一个普通文献条目。");
      return;
    }

    const results: IdentifierCompletionResult[] = [];
    for (const item of items) results.push(await PubMedQA.completeIdentifiers(item));
    const counts = countStatuses(results);
    const conflicts = results.filter(x => x.status === "conflict").slice(0, 8);
    const details = conflicts.length ? `\n\n冲突示例：\n${conflicts.map(x => `• ${x.message}`).join("\n")}` : "";
    Services.prompt.alert(
      win,
      PLUGIN_NAME,
      `PubMed 标识符处理完成。\n新增/更新：${counts.updated || 0}\n无需修改：${counts.unchanged || 0}\n未找到：${counts.not_found || 0}\n冲突：${counts.conflict || 0}\n跳过：${counts.skipped || 0}\n错误：${counts.error || 0}${details}`
    );
  }

  private async validateSelected(win: any) {
    const items = this.selectedItems(win);
    if (!items.length) {
      Services.prompt.alert(win, PLUGIN_NAME, "请先选择至少一个普通文献条目。");
      return;
    }

    const results: MetadataValidationResult[] = [];
    for (const item of items) results.push(await PubMedQA.validateMetadata(item));
    const counts = countStatuses(results);
    const conflicts = results.filter(x => x.status === "conflict").slice(0, 6);
    const details = conflicts.length
      ? `\n\n需复核：\n${conflicts.map(x => {
          const diff = x.differences.slice(0, 3).join("; ");
          return `• ${truncate(x.title, 70)}${diff ? `\n  ${diff}` : ""}`;
        }).join("\n")}`
      : "";

    Services.prompt.alert(
      win,
      PLUGIN_NAME,
      `PubMed metadata 校验完成（未替换任何 metadata）。\n通过：${counts.verified || 0}\n冲突：${counts.conflict || 0}\n无 PubMed 记录：${counts.no_pubmed || 0}\n错误：${counts.error || 0}${details}`
    );
  }

  private async replaceSelected(win: any) {
    const items = this.selectedItems(win);
    if (!items.length) {
      Services.prompt.alert(win, PLUGIN_NAME, "请先选择至少一个普通文献条目。");
      return;
    }

    const counts: Record<string, number> = { updated: 0, unchanged: 0, skipped: 0, conflict: 0, no_pubmed: 0, error: 0 };
    for (const item of items) {
      const preview = await PubMedQA.prepareMetadataReplacement(item);
      if (preview.status !== "ready") {
        counts[preview.status] = (counts[preview.status] || 0) + 1;
        continue;
      }

      const decision = this.confirmReplacement(win, preview);
      if (decision === "skip") {
        counts.skipped++;
        continue;
      }

      const applied = await PubMedQA.applyMetadataReplacement(item, preview, decision === "with_authors");
      counts[applied.status] = (counts[applied.status] || 0) + 1;
    }

    Services.prompt.alert(
      win,
      PLUGIN_NAME,
      `PubMed metadata 替换完成。\n已更新：${counts.updated || 0}\n无需修改：${counts.unchanged || 0}\n人工跳过：${counts.skipped || 0}\n标识符冲突：${counts.conflict || 0}\n无 PubMed 记录：${counts.no_pubmed || 0}\n错误：${counts.error || 0}\n\n所有替换均经过逐条预览确认；附件、笔记、标签、Collection 与其他 Extra 内容不会被替换。`
    );
  }

  private confirmReplacement(win: any, preview: MetadataReplacementPreview): "without_authors" | "with_authors" | "skip" {
    const authorChange = preview.changes.some(x => x.field === "creators");
    const lines = preview.changes.slice(0, 12).map(change =>
      `• ${change.label}\n  Zotero: ${truncate(change.from || "∅", 110)}\n  PubMed: ${truncate(change.to || "∅", 110)}`
    );
    const more = preview.changes.length > 12 ? `\n…另有 ${preview.changes.length - 12} 项差异` : "";
    const message = [
      `条目：${truncate(preview.title, 120)}`,
      `PMID：${preview.pmid}`,
      "",
      ...lines,
      more,
      "",
      "确认后只替换上面显示的 bibliographic metadata。PMID/PMCID 使用 Zotero 原生字段；附件、笔记、标签、Collection 和无关 Extra 内容保持不变。"
    ].filter(Boolean).join("\n");

    if (!authorChange) {
      return Services.prompt.confirm(win, "PubMed metadata 替换确认", `${message}\n\n是否替换？`) ? "without_authors" : "skip";
    }

    const ps = Services.prompt;
    const flags = ps.BUTTON_POS_0 * ps.BUTTON_TITLE_IS_STRING
      + ps.BUTTON_POS_1 * ps.BUTTON_TITLE_IS_STRING
      + ps.BUTTON_POS_2 * ps.BUTTON_TITLE_IS_STRING;
    const choice = ps.confirmEx(
      win,
      "PubMed metadata 替换确认",
      `${message}\n\nPubMed 作者来自结构化 XML。你可以保留 Zotero 当前作者，或同时使用 PubMed 作者替换。`,
      flags,
      "替换（保留作者）",
      "替换（含作者）",
      "跳过",
      null,
      { value: false }
    );
    if (choice === 0) return "without_authors";
    if (choice === 1) return "with_authors";
    return "skip";
  }

  private autoEnabled(): boolean {
    const value = Zotero.Prefs.get(`${PREF_PREFIX}.pubmedAutoIdentifiers`);
    return value === undefined || value === null ? true : Boolean(value);
  }

  private configureNCBIEmail(win: any) {
    const value = { value: String(Zotero.Prefs.get(`${PREF_PREFIX}.ncbiEmail`) || "") };
    const ok = Services.prompt.prompt(
      win,
      PLUGIN_NAME,
      "NCBI 建议 API 请求携带维护者联系邮箱。可在此填写；留空也不会阻止查询。",
      value,
      "",
      { value: false }
    );
    if (!ok) return;
    const email = String(value.value || "").trim();
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      Services.prompt.alert(win, PLUGIN_NAME, "邮箱格式看起来不正确，未保存。");
      return;
    }
    Zotero.Prefs.set(`${PREF_PREFIX}.ncbiEmail`, email);
    Services.prompt.alert(win, PLUGIN_NAME, email ? "NCBI 联系邮箱已保存。" : "NCBI 联系邮箱已清空。");
  }
}

function countStatuses(results: Array<{ status: string }>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of results) out[r.status] = (out[r.status] || 0) + 1;
  return out;
}

function truncate(value: string, max: number): string {
  const text = String(value || "");
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
