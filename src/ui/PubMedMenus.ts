import { PLUGIN_NAME, PREF_PREFIX } from "../config";
import { PubMedQA, type IdentifierCompletionResult, type MetadataValidationResult } from "../core/PubMedQA";

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

    popup.append(sep, complete, validate);
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
      `PubMed 标识符处理完成。\n新增/更新：${counts.updated || 0}\n无需修改：${counts.unchanged || 0}\n未找到：${counts.not_found || 0}\n冲突：${counts.conflict || 0}\n错误：${counts.error || 0}${details}`
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
