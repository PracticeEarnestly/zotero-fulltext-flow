(() => {
  const PREF_PREFIX = "extensions.zotero.fullTextFlow";
  const PLUGIN_NAME = "FullTextFlow for Zotero";
  const JLSS_BASE_URL = "https://api.jlss.vip";
  const TASK_SUCCESS = "2";
  const TASK_FAILED = new Set(["3", "6"]);

  function field(item, name) {
    return String(item.getField?.(name) || "").trim();
  }
  function extractPMID(extra) {
    const match = String(extra || "").match(/(?:^|\n)\s*PMID\s*:\s*(\d+)/i);
    return match?.[1] || "";
  }
  function extractItemMetadata(item) {
    const doi = field(item, "DOI");
    const pmid = extractPMID(field(item, "extra"));
    const title = field(item, "title");
    const url = field(item, "url");
    const queryText = doi || pmid || title || url;
    return {
      itemID: Number(item.id),
      itemKey: String(item.key || item.id),
      libraryID: Number(item.libraryID),
      doi, pmid, title, url, queryText,
      queryType: doi ? "doi" : pmid ? "pmid" : title ? "title" : url ? "url" : null
    };
  }
  function normalizeQuery(value) {
    return String(value || "").trim().toLowerCase().replace(/^https?:\/\/(dx\.)?doi\.org\//, "");
  }

  async function hasUsablePDF(item) {
    const attachmentIDs = item.getAttachments?.() || [];
    if (!attachmentIDs.length) return false;
    const attachments = await Zotero.Items.getAsync(attachmentIDs);
    for (const attachment of attachments || []) {
      if (!attachment) continue;
      const type = String(attachment.attachmentContentType || "").toLowerCase();
      const isPDF = attachment.isPDFAttachment?.() || type === "application/pdf";
      if (!isPDF) continue;
      try {
        const path = await attachment.getFilePathAsync?.();
        if (path && await IOUtils.exists(path)) return true;
      } catch (_) {}
    }
    return false;
  }

  class QueueStore {
    static load() {
      const raw = String(Zotero.Prefs.get(`${PREF_PREFIX}.queue`) || "[]");
      try {
        const value = JSON.parse(raw);
        return Array.isArray(value) ? value : [];
      } catch (_) { return []; }
    }
    static save(entries) { Zotero.Prefs.set(`${PREF_PREFIX}.queue`, JSON.stringify(entries)); }
    static upsert(metadata) {
      const entries = this.load();
      const existing = entries.find(e => e.libraryID === metadata.libraryID && e.itemKey === metadata.itemKey);
      if (existing) return existing;
      const now = new Date().toISOString();
      const entry = {
        itemID: metadata.itemID, itemKey: metadata.itemKey, libraryID: metadata.libraryID,
        queryText: metadata.queryText, queryType: metadata.queryType, title: metadata.title,
        state: "queued", updatedAt: now
      };
      entries.push(entry); this.save(entries); return entry;
    }
    static patch(itemKey, libraryID, patch) {
      const entries = this.load();
      const entry = entries.find(e => e.itemKey === itemKey && e.libraryID === libraryID);
      if (!entry) return;
      Object.assign(entry, patch, { updatedAt: new Date().toISOString() });
      this.save(entries);
    }
    static active() { return this.load().filter(e => !["done", "failed"].includes(e.state)); }
    static countByState() {
      const result = {};
      for (const e of this.load()) result[e.state] = (result[e.state] || 0) + 1;
      return result;
    }
  }

  class JLSSClient {
    static token() { return String(Zotero.Prefs.get(`${PREF_PREFIX}.token`) || "").trim(); }
    static async post(path, body) {
      const token = this.token();
      if (!token) throw new Error("尚未配置聚联 token。请在“工具 → FullTextFlow 设置”中填写。");
      const response = await Zotero.HTTP.request("POST", `${JLSS_BASE_URL}${path}`, {
        body: JSON.stringify(body),
        headers: { Accept: "application/json, text/plain, */*", "Content-Type": "application/json", token },
        responseType: "text", successCodes: false, timeout: 60000
      });
      if (response.status === 401 || response.status === 403) throw new Error("聚联登录状态已失效，请更新 token。");
      let data;
      try { data = JSON.parse(response.responseText || "{}"); }
      catch (_) { throw new Error("聚联返回了非 JSON 数据，登录状态或接口可能已变化。"); }
      if (data?.code === 501) throw new Error("聚联 token 已失效，请更新 token。");
      if (response.status < 200 || response.status >= 300 || data?.code !== 200) {
        throw new Error(data?.msg || data?.mess || data?.message || `聚联请求失败 HTTP ${response.status}`);
      }
      return data;
    }
    static submit(metadata) {
      if (!metadata.queryText) throw new Error("条目缺少 DOI、PMID、标题和 URL。");
      return this.post("/search/trans", { content: metadata.queryText });
    }
    static async listAllTasks() {
      const all = [], pageSize = 50;
      for (let page = 1; page <= 20; page++) {
        const response = await this.post("/task/myHelpList", {
          currentPage: page, pageSize,
          data: { taskStatus: "", startTime: "", endTime: "" }
        });
        const payload = response?.data || {};
        const rows = payload.dataList || payload.list || payload.records || [];
        if (!Array.isArray(rows)) throw new Error("聚联任务列表格式异常。");
        for (const row of rows) {
          all.push({
            taskTitle: String(row.taskTitle || ""), taskCode: String(row.taskCode || ""),
            createTime: String(row.createTime || ""), taskStatus: String(row.taskStatus ?? ""),
            uuid: String(row.uuid || ""), resourceUuid: String(row.resourceUuid || "")
          });
        }
        if (rows.length < pageSize) break;
      }
      return all;
    }
    static async getDownloadURL(record) {
      if (!record.resourceUuid || !record.uuid) throw new Error("聚联任务缺少下载参数。");
      const response = await this.post("/task/clickDownload", { resourceUuid: record.resourceUuid, uuid: record.uuid });
      const payload = response?.data || {};
      if (payload.code !== 0 || !payload.data) throw new Error(payload.msg || "聚联未返回 PDF 下载链接。");
      return String(payload.data);
    }
  }

  class PdfImporter {
    static async importFromURL(item, entry, url) {
      const attachment = await Zotero.Attachments.importFromURL({
        libraryID: item.libraryID, url, parentItemID: item.id,
        title: entry.title || item.getDisplayTitle?.() || "Full Text PDF",
        fileBaseName: this.fileBaseName(entry), contentType: "application/pdf",
        referrer: "", cookieSandbox: null
      });
      const path = await attachment.getFilePathAsync?.();
      if (!path || !(await IOUtils.exists(path))) {
        await attachment.eraseTx?.(); throw new Error("下载后未找到本地 PDF 文件。");
      }
      const stat = await IOUtils.stat(path);
      if (Number(stat.size || 0) < 10000) {
        await attachment.eraseTx?.(); throw new Error("下载文件过小，未通过 PDF 完整性检查。");
      }
      const head = await IOUtils.read(path, { maxBytes: 5 });
      const signature = String.fromCharCode(...Array.from(head));
      if (signature !== "%PDF-") {
        await attachment.eraseTx?.(); throw new Error("下载文件不是有效 PDF。");
      }
      return attachment;
    }
    static fileBaseName(entry) {
      return String(entry.title || entry.queryText || entry.itemKey)
        .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_").replace(/\s+/g, " ").trim().slice(0, 120) || "FullTextFlow";
    }
  }

  class CollectionScanner {
    static async collectItems(collection, recursive) {
      const map = new Map();
      const visit = async c => {
        const children = await Promise.resolve(c.getChildItems?.(false, false) || []);
        for (const item of children) {
          const resolved = typeof item === "number" ? Zotero.Items.get(item) : item;
          if (resolved) map.set(`${resolved.libraryID}:${resolved.key || resolved.id}`, resolved);
        }
        if (!recursive) return;
        const subcollections = await Promise.resolve(c.getChildCollections?.(false) || []);
        for (const sub of subcollections) {
          const resolved = typeof sub === "number" ? Zotero.Collections.get(sub) : sub;
          if (resolved) await visit(resolved);
        }
      };
      await visit(collection); return Array.from(map.values());
    }
    static async scan(collection, recursive) {
      const items = await this.collectItems(collection, recursive);
      const result = { total: items.length, regular: 0, withPDF: 0, missingPDF: [], noIdentifier: 0 };
      for (const item of items) {
        if (!item?.isRegularItem?.()) continue;
        result.regular++;
        if (await hasUsablePDF(item)) { result.withPDF++; continue; }
        const metadata = extractItemMetadata(item);
        if (!metadata.queryText) { result.noIdentifier++; continue; }
        result.missingPDF.push(metadata);
      }
      return result;
    }
  }

  class FlowEngine {
    constructor() { this.timer = null; this.polling = false; }
    start() {
      this.stop();
      const minutes = Math.max(1, Number(Zotero.Prefs.get(`${PREF_PREFIX}.pollMinutes`) || 5));
      this.timer = setInterval(() => this.poll().catch(e => Zotero.debug(`FullTextFlow poll error: ${e}`)), minutes * 60000);
      setTimeout(() => this.poll().catch(() => {}), 15000);
    }
    stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }
    async enqueueMetadata(list) {
      let queued = 0, skipped = 0, failed = 0;
      const maxBatch = Math.max(1, Number(Zotero.Prefs.get(`${PREF_PREFIX}.maxBatch`) || 50));
      for (const metadata of list.slice(0, maxBatch)) {
        const item = Zotero.Items.get(metadata.itemID);
        if (!item || await hasUsablePDF(item)) { skipped++; continue; }
        const existing = QueueStore.load().find(e => e.libraryID === metadata.libraryID && e.itemKey === metadata.itemKey);
        if (existing && !["failed", "done"].includes(existing.state)) { skipped++; continue; }
        try {
          QueueStore.upsert(metadata);
          await JLSSClient.submit(metadata);
          QueueStore.patch(metadata.itemKey, metadata.libraryID, { state: "submitted", submittedAt: new Date().toISOString(), error: undefined });
          queued++; await new Promise(resolve => setTimeout(resolve, 650));
        } catch (e) {
          QueueStore.patch(metadata.itemKey, metadata.libraryID, { state: "failed", error: e instanceof Error ? e.message : String(e) });
          failed++;
        }
      }
      setTimeout(() => this.poll().catch(() => {}), 8000);
      return { queued, skipped, failed };
    }
    async enqueueItems(items) {
      const list = [];
      for (const item of items) {
        if (!item?.isRegularItem?.() || await hasUsablePDF(item)) continue;
        const md = extractItemMetadata(item); if (md.queryText) list.push(md);
      }
      return this.enqueueMetadata(list);
    }
    async poll() {
      if (this.polling) return;
      const active = QueueStore.active(); if (!active.length) return;
      this.polling = true;
      try {
        const records = await JLSSClient.listAllTasks();
        for (const entry of active) {
          const item = Zotero.Items.get(entry.itemID);
          if (!item) { QueueStore.patch(entry.itemKey, entry.libraryID, { state: "failed", error: "Zotero 条目已不存在。" }); continue; }
          if (await hasUsablePDF(item)) { QueueStore.patch(entry.itemKey, entry.libraryID, { state: "done", error: undefined }); continue; }
          const q = normalizeQuery(entry.queryText);
          const record = records.find(r => normalizeQuery(r.taskTitle) === q);
          if (!record) { QueueStore.patch(entry.itemKey, entry.libraryID, { state: "pending" }); continue; }
          QueueStore.patch(entry.itemKey, entry.libraryID, {
            taskUUID: record.uuid, resourceUUID: record.resourceUuid, taskCode: record.taskCode,
            state: record.taskStatus === TASK_SUCCESS ? "downloading" : "pending"
          });
          if (TASK_FAILED.has(record.taskStatus)) {
            QueueStore.patch(entry.itemKey, entry.libraryID, { state: "failed", error: `聚联任务失败（status=${record.taskStatus}）` }); continue;
          }
          if (record.taskStatus !== TASK_SUCCESS) continue;
          try {
            const url = await JLSSClient.getDownloadURL(record);
            await PdfImporter.importFromURL(item, entry, url);
            QueueStore.patch(entry.itemKey, entry.libraryID, { state: "done", error: undefined });
          } catch (e) {
            QueueStore.patch(entry.itemKey, entry.libraryID, { state: "failed", error: e instanceof Error ? e.message : String(e) });
          }
        }
      } finally { this.polling = false; }
    }
  }

  class Menus {
    constructor(engine) { this.engine = engine; this.windows = new Set(); }
    register(win) {
      if (this.windows.has(win)) return;
      this.windows.add(win); this.registerItemMenu(win); this.registerCollectionMenu(win); this.registerToolsMenu(win);
    }
    unregister(win) {
      const doc = win.document;
      for (const id of ["fulltextflow-item", "fulltextflow-item-sep", "fulltextflow-collection-root", "fulltextflow-collection-sep", "fulltextflow-tools-settings", "fulltextflow-tools-status"])
        doc.getElementById(id)?.remove();
      this.windows.delete(win);
    }
    unregisterAll() { for (const win of Array.from(this.windows)) this.unregister(win); }
    menuItem(win, label, fn) {
      const item = win.document.createXULElement("menuitem"); item.setAttribute("label", label);
      item.addEventListener("command", () => Promise.resolve(fn()).catch(e => Services.prompt.alert(win, PLUGIN_NAME, e instanceof Error ? e.message : String(e))));
      return item;
    }
    registerItemMenu(win) {
      const popup = win.document.getElementById("zotero-itemmenu"); if (!popup) return;
      const sep = win.document.createXULElement("menuseparator"); sep.id = "fulltextflow-item-sep";
      const item = this.menuItem(win, "FullTextFlow：获取缺失全文", async () => {
        const selected = win.ZoteroPane?.getSelectedItems?.() || [];
        const result = await this.engine.enqueueItems(selected);
        Services.prompt.alert(win, PLUGIN_NAME, `已提交 ${result.queued} 篇；跳过 ${result.skipped} 篇；失败 ${result.failed} 篇。`);
      });
      item.id = "fulltextflow-item"; popup.append(sep, item);
    }
    registerCollectionMenu(win) {
      const popup = win.document.getElementById("zotero-collectionmenu"); if (!popup) return;
      const sep = win.document.createXULElement("menuseparator"); sep.id = "fulltextflow-collection-sep";
      const root = win.document.createXULElement("menu"); root.id = "fulltextflow-collection-root"; root.setAttribute("label", "FullTextFlow");
      const menupopup = win.document.createXULElement("menupopup");
      menupopup.append(
        this.menuItem(win, "补齐本分类缺失全文", () => this.scanAndSubmit(win, false)),
        this.menuItem(win, "补齐本分类及子分类缺失全文", () => this.scanAndSubmit(win, true)),
        this.menuItem(win, "切换：自动补全文此分类", () => this.toggleAuto(win)),
        this.menuItem(win, "立即检查聚联任务", async () => { await this.engine.poll(); this.showStatus(win); })
      );
      root.append(menupopup); popup.append(sep, root);
    }
    registerToolsMenu(win) {
      const popup = win.document.getElementById("menu_ToolsPopup"); if (!popup) return;
      const settings = this.menuItem(win, "FullTextFlow 设置", () => this.openSettings(win)); settings.id = "fulltextflow-tools-settings";
      const status = this.menuItem(win, "FullTextFlow 任务状态", () => this.showStatus(win)); status.id = "fulltextflow-tools-status";
      popup.append(settings, status);
    }
    selectedCollection(win) {
      return win.ZoteroPane?.getSelectedCollection?.() || win.ZoteroPane?.collectionsView?.getSelectedCollection?.() || null;
    }
    async scanAndSubmit(win, recursive) {
      const collection = this.selectedCollection(win);
      if (!collection) throw new Error("请先在左侧选择一个普通分类文件夹（Collection）。");
      const scan = await CollectionScanner.scan(collection, recursive);
      const maxBatch = Number(Zotero.Prefs.get(`${PREF_PREFIX}.maxBatch`) || 50);
      const submitCount = Math.min(scan.missingPDF.length, maxBatch);
      const summary = [
        `分类：${collection.name || "未命名"}`, `范围：${recursive ? "本分类 + 全部子分类" : "仅本分类"}`,
        `条目总数：${scan.total}`, `普通文献：${scan.regular}`, `已有 PDF：${scan.withPDF}`,
        `缺少 PDF：${scan.missingPDF.length}`, `无可用标识：${scan.noIdentifier}`, `本次最多提交：${submitCount}`
      ].join("\n");
      if (!scan.missingPDF.length) { Services.prompt.alert(win, PLUGIN_NAME, `${summary}\n\n没有需要补齐的全文。`); return; }
      if (!Services.prompt.confirm(win, PLUGIN_NAME, `${summary}\n\n开始提交到聚联吗？`)) return;
      const result = await this.engine.enqueueMetadata(scan.missingPDF);
      Services.prompt.alert(win, PLUGIN_NAME, `完成提交：${result.queued} 篇；跳过 ${result.skipped} 篇；失败 ${result.failed} 篇。\n后续任务会在后台自动检查。`);
    }
    autoList() {
      try { const v = JSON.parse(String(Zotero.Prefs.get(`${PREF_PREFIX}.autoCollections`) || "[]")); return Array.isArray(v) ? v : []; }
      catch (_) { return []; }
    }
    toggleAuto(win) {
      const collection = this.selectedCollection(win); if (!collection) throw new Error("请先选择分类文件夹。");
      const key = `${collection.libraryID}:${collection.key}`, list = this.autoList(), idx = list.indexOf(key);
      if (idx >= 0) list.splice(idx, 1); else list.push(key);
      Zotero.Prefs.set(`${PREF_PREFIX}.autoCollections`, JSON.stringify(list));
      Services.prompt.alert(win, PLUGIN_NAME, idx >= 0 ? `已关闭“${collection.name}”自动补全文。` : `已启用“${collection.name}”自动补全文。新加入该分类的文献会进入队列。`);
    }
    async openSettings(win) {
      const tokenPref = `${PREF_PREFIX}.token`, currentToken = String(Zotero.Prefs.get(tokenPref) || ""), value = { value: currentToken };
      const ok = Services.prompt.prompt(win, PLUGIN_NAME, "聚联 token（仅保存在本机 Zotero 首选项）：", value, "", { value: false });
      if (!ok) return;
      Zotero.Prefs.set(tokenPref, String(value.value || "").trim());
      try { await JLSSClient.listAllTasks(); Services.prompt.alert(win, PLUGIN_NAME, "Token 已保存，聚联连接测试成功。"); }
      catch (e) { Services.prompt.alert(win, PLUGIN_NAME, `Token 已保存，但连接测试失败：\n${e instanceof Error ? e.message : String(e)}`); }
    }
    showStatus(win) {
      const counts = QueueStore.countByState(), active = QueueStore.active().length;
      const lines = Object.entries(counts).map(([k, v]) => `${k}: ${v}`);
      Services.prompt.alert(win, PLUGIN_NAME, `当前活动任务：${active}\n\n${lines.join("\n") || "暂无任务"}`);
    }
  }

  class AutoWatcher {
    constructor(engine) { this.engine = engine; this.observerID = null; }
    start() {
      if (this.observerID) return;
      const observer = { notify: async (event, type, ids) => {
        if (type !== "item" || !["add", "modify"].includes(event)) return;
        const auto = this.autoCollections(); if (!auto.size) return;
        for (const id of ids || []) {
          const item = Zotero.Items.get(id);
          if (!item?.isRegularItem?.() || await hasUsablePDF(item)) continue;
          const memberships = item.getCollections?.() || [];
          let enabled = false;
          for (const cid of memberships) {
            const c = Zotero.Collections.get(cid);
            if (c && auto.has(`${c.libraryID}:${c.key}`)) { enabled = true; break; }
          }
          if (!enabled) continue;
          const metadata = extractItemMetadata(item);
          if (metadata.queryText) await this.engine.enqueueMetadata([metadata]);
        }
      }};
      this.observerID = Zotero.Notifier.registerObserver(observer, ["item"], "fulltextflow", 1);
    }
    stop() { if (this.observerID) Zotero.Notifier.unregisterObserver(this.observerID); this.observerID = null; }
    autoCollections() {
      try { const value = JSON.parse(String(Zotero.Prefs.get(`${PREF_PREFIX}.autoCollections`) || "[]")); return new Set(Array.isArray(value) ? value : []); }
      catch (_) { return new Set(); }
    }
  }

  class FullTextFlowAddon {
    constructor() {
      this.data = { initialized: false };
      this.engine = new FlowEngine();
      this.watcher = new AutoWatcher(this.engine);
      this.menus = new Menus(this.engine);
      this.hooks = {
        onStartup: async () => {
          await Promise.all([Zotero.initializationPromise, Zotero.unlockPromise, Zotero.uiReadyPromise]);
          for (const win of Zotero.getMainWindows()) this.menus.register(win);
          this.engine.start(); this.watcher.start(); this.data.initialized = true;
          Zotero.debug("FullTextFlow initialized");
        },
        onMainWindowLoad: async win => this.menus.register(win),
        onMainWindowUnload: async win => this.menus.unregister(win),
        onShutdown: async () => {
          this.engine.stop(); this.watcher.stop(); this.menus.unregisterAll();
          this.data.initialized = false; delete Zotero.FullTextFlow;
        }
      };
    }
  }

  Zotero.FullTextFlow = new FullTextFlowAddon();
})();
