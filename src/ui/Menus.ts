import { PLUGIN_NAME, PREF_PREFIX } from "../config";
import { CollectionScanner } from "../core/CollectionScanner";
import { QueueStore } from "../core/QueueStore";
import type { FlowEngine } from "../core/FlowEngine";
import { JLSSClient } from "../core/JLSSClient";
import { AuthManager } from "../core/AuthManager";
import { AuthWindow } from "./AuthWindow";
import { TaskManager } from "./TaskManager";

export class Menus {
  private windows = new Set<any>();
  private collectionPopupHandlers = new WeakMap<any, EventListener>();
  constructor(private engine: FlowEngine) {}

  register(win: any) {
    if (this.windows.has(win)) return;
    this.windows.add(win);
    this.registerItemMenu(win);
    this.registerCollectionMenu(win);
    this.registerToolsMenu(win);
  }

  unregister(win: any) {
    const doc = win.document;
    const popup = doc.getElementById("zotero-collectionmenu");
    const handler = this.collectionPopupHandlers.get(win);
    if (popup && handler) popup.removeEventListener("popupshowing", handler);
    this.collectionPopupHandlers.delete(win);
    for (const id of [
      "fulltextflow-item", "fulltextflow-item-sep",
      "fulltextflow-collection-root", "fulltextflow-collection-sep",
      "fulltextflow-tools-settings", "fulltextflow-tools-login", "fulltextflow-tools-token",
      "fulltextflow-tools-status", "fulltextflow-tools-tasks"
    ]) doc.getElementById(id)?.remove();
    this.windows.delete(win);
  }

  unregisterAll() { for (const win of Array.from(this.windows)) this.unregister(win); }

  private registerItemMenu(win: any) {
    const popup = win.document.getElementById("zotero-itemmenu");
    if (!popup) return;
    const sep = win.document.createXULElement("menuseparator"); sep.id = "fulltextflow-item-sep";
    const item = win.document.createXULElement("menuitem"); item.id = "fulltextflow-item";
    item.setAttribute("label", "FullTextFlow：获取缺失全文");
    item.addEventListener("command", async () => {
      const selected = win.ZoteroPane?.getSelectedItems?.() || [];
      const result = await this.engine.enqueueItems(selected);
      Services.prompt.alert(
        win,
        PLUGIN_NAME,
        `Zotero 直接找到 ${result.native} 篇；提交聚联 ${result.queued} 篇；等待登录 ${result.waitingAuth} 篇；跳过 ${result.skipped} 篇；失败 ${result.failed} 篇。`
      );
      if (result.waitingAuth) await AuthWindow.open(win, this.engine);
    });
    popup.append(sep, item);
  }

  private registerCollectionMenu(win: any) {
    const popup = win.document.getElementById("zotero-collectionmenu");
    if (!popup) return;
    const sep = win.document.createXULElement("menuseparator"); sep.id = "fulltextflow-collection-sep";
    const root = win.document.createXULElement("menu"); root.id = "fulltextflow-collection-root"; root.setAttribute("label", "FullTextFlow");
    const menupopup = win.document.createXULElement("menupopup");
    const current = this.menuItem(win, "补齐本分类缺失全文", () => this.scanAndSubmit(win, false));
    const recursive = this.menuItem(win, "补齐本分类及子分类缺失全文", () => this.scanAndSubmit(win, true));
    const auto = this.menuItem(win, "自动补全文此分类");
    auto.id = "fulltextflow-collection-auto";
    auto.setAttribute("type", "checkbox");
    auto.addEventListener("command", () => this.toggleAuto(win));
    const login = this.menuItem(win, "聚联登录/刷新登录", () => AuthWindow.open(win, this.engine));
    const tasks = this.menuItem(win, "查看任务", () => TaskManager.open(win, this.engine));
    const poll = this.menuItem(win, "立即检查聚联任务", async () => { await this.engine.poll(); TaskManager.open(win, this.engine); });
    menupopup.append(current, recursive, auto, login, tasks, poll);
    root.append(menupopup);
    popup.append(sep, root);

    const handler: EventListener = () => {
      const collection = this.selectedCollection(win);
      const usable = Boolean(collection?.key && collection?.libraryID);
      root.toggleAttribute("hidden", !usable);
      sep.toggleAttribute("hidden", !usable);
      if (!usable) return;
      const key = `${collection.libraryID}:${collection.key}`;
      auto.setAttribute("checked", this.autoList().includes(key) ? "true" : "false");
    };
    popup.addEventListener("popupshowing", handler);
    this.collectionPopupHandlers.set(win, handler);
  }

  private registerToolsMenu(win: any) {
    const popup = win.document.getElementById("menu_ToolsPopup");
    if (!popup) return;

    const login = this.menuItem(win, "FullTextFlow 聚联登录", () => AuthWindow.open(win, this.engine));
    login.id = "fulltextflow-tools-login";
    const settings = this.menuItem(win, "FullTextFlow 聚联账号", () => this.configureCredentials(win));
    settings.id = "fulltextflow-tools-settings";
    const token = this.menuItem(win, "FullTextFlow 手动 Token（备用）", () => this.manualToken(win));
    token.id = "fulltextflow-tools-token";
    const tasks = this.menuItem(win, "FullTextFlow 任务管理", () => TaskManager.open(win, this.engine));
    tasks.id = "fulltextflow-tools-tasks";
    const status = this.menuItem(win, "FullTextFlow 任务概览", () => this.showStatus(win));
    status.id = "fulltextflow-tools-status";
    popup.append(login, settings, token, tasks, status);
  }

  private menuItem(win: any, label: string, fn?: () => void | Promise<void>) {
    const item = win.document.createXULElement("menuitem");
    item.setAttribute("label", label);
    if (fn) item.addEventListener("command", () => Promise.resolve(fn()).catch(e => Services.prompt.alert(win, PLUGIN_NAME, e instanceof Error ? e.message : String(e))));
    return item;
  }

  private selectedCollection(win: any): any {
    return win.ZoteroPane?.getSelectedCollection?.() || win.ZoteroPane?.collectionsView?.getSelectedCollection?.() || null;
  }

  private async scanAndSubmit(win: any, recursive: boolean) {
    const collection = this.selectedCollection(win);
    if (!collection) throw new Error("请先在左侧选择一个普通分类文件夹（Collection）。");
    const scan = await CollectionScanner.scan(collection, recursive);
    const maxBatch = Number(Zotero.Prefs.get(`${PREF_PREFIX}.maxBatch`) || 50);
    const submitCount = Math.min(scan.missingPDF.length, maxBatch);
    const nativeFirst = this.prefBool(`${PREF_PREFIX}.nativeFirst`, true);
    const summary = [
      `分类：${collection.name || "未命名"}`,
      `范围：${recursive ? "本分类 + 全部子分类" : "仅本分类"}`,
      `条目总数：${scan.total}`,
      `普通文献：${scan.regular}`,
      `已有 PDF：${scan.withPDF}`,
      `缺少 PDF：${scan.missingPDF.length}`,
      `无可用标识：${scan.noIdentifier}`,
      `本次最多处理：${submitCount}`,
      `获取顺序：${nativeFirst ? "Zotero Find Full Text → 聚联" : "聚联"}`
    ].join("\n");
    if (!scan.missingPDF.length) { Services.prompt.alert(win, PLUGIN_NAME, `${summary}\n\n没有需要补齐的全文。`); return; }
    if (!Services.prompt.confirm(win, PLUGIN_NAME, `${summary}\n\n开始查找全文吗？`)) return;
    const result = await this.engine.enqueueMetadata(scan.missingPDF);
    Services.prompt.alert(
      win,
      PLUGIN_NAME,
      `处理完成：Zotero 直接找到 ${result.native} 篇；提交聚联 ${result.queued} 篇；等待登录 ${result.waitingAuth} 篇；跳过 ${result.skipped} 篇；失败 ${result.failed} 篇。\n聚联任务会在后台自动检查。`
    );
    if (result.waitingAuth) await AuthWindow.open(win, this.engine);
  }

  private autoList(): string[] {
    try { const v = JSON.parse(String(Zotero.Prefs.get(`${PREF_PREFIX}.autoCollections`) || "[]")); return Array.isArray(v) ? v : []; }
    catch (_) { return []; }
  }

  private toggleAuto(win: any) {
    const collection = this.selectedCollection(win);
    if (!collection) throw new Error("请先选择分类文件夹。");
    const key = `${collection.libraryID}:${collection.key}`;
    const list = this.autoList();
    const idx = list.indexOf(key);
    if (idx >= 0) list.splice(idx, 1); else list.push(key);
    Zotero.Prefs.set(`${PREF_PREFIX}.autoCollections`, JSON.stringify(list));
    Services.prompt.alert(win, PLUGIN_NAME, idx >= 0 ? `已关闭“${collection.name}”自动补全文。` : `已启用“${collection.name}”自动补全文。新加入该分类的文献会自动处理。`);
  }

  private async configureCredentials(win: any) {
    const current = await AuthManager.credentials();
    const username = { value: current.username || "" };
    const password = { value: current.password || "" };
    const ok = (Services.prompt.promptUsernameAndPassword as any)(
      win,
      PLUGIN_NAME,
      "输入聚联网页登录账号和密码。凭证仅保存在 Zotero/Firefox Login Manager，不写入普通首选项或日志。",
      username,
      password,
      null,
      { value: false }
    );
    if (!ok) return;
    if (!String(username.value || "").trim() || !String(password.value || "")) {
      throw new Error("账号和密码不能为空。");
    }
    await AuthManager.setCredentials(String(username.value).trim(), String(password.value));
    await AuthManager.clearToken();
    Services.prompt.alert(win, PLUGIN_NAME, "聚联账号已安全保存。接下来会打开聚联登录页并尝试自动登录。若出现验证码，请手动完成一次。");
    await AuthWindow.open(win, this.engine);
  }

  private async manualToken(win: any) {
    const currentToken = await AuthManager.token();
    const value = { value: currentToken };
    const ok = Services.prompt.prompt(win, PLUGIN_NAME, "聚联 token（备用方式；将安全保存到 Login Manager）：", value, "", { value: false });
    if (!ok) return;
    await AuthManager.setToken(String(value.value || "").trim());
    try {
      await JLSSClient.testConnection();
      Services.prompt.alert(win, PLUGIN_NAME, "Token 已安全保存，聚联连接测试成功。正在恢复等待登录的任务。");
      await this.engine.resumeAuthWaiting();
    }
    catch (e) {
      Services.prompt.alert(win, PLUGIN_NAME, `Token 已保存，但连接测试失败：\n${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private async showStatus(win: any) {
    const counts = QueueStore.countByState();
    const active = QueueStore.active().length;
    const hasToken = await AuthManager.hasToken();
    const hasCredentials = await AuthManager.hasCredentials();
    const lines = Object.entries(counts).map(([k,v]) => `${k}: ${v}`);
    Services.prompt.alert(
      win,
      PLUGIN_NAME,
      `聚联 token：${hasToken ? "已保存" : "未登录"}\n自动登录凭证：${hasCredentials ? "已保存" : "未设置"}\n当前活动任务：${active}\n\n${lines.join("\n") || "暂无任务"}`
    );
  }

  private prefBool(name: string, fallback: boolean) {
    const value = Zotero.Prefs.get(name);
    return value === undefined || value === null ? fallback : Boolean(value);
  }
}
