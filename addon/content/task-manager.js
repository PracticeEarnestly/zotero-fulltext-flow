/* global window, document */
(() => {
  const api = window.arguments?.[0]?.wrappedJSObject;
  const HTML_NS = "http://www.w3.org/1999/xhtml";
  const labels = {
    queued: "等待提交", native_search: "Zotero 查找中", waiting_auth: "等待登录", waiting_quota: "等待额度恢复",
    submitted: "聚联已提交", pending: "聚联处理中", downloading: "下载 / 核验中",
    done: "已完成", review: "需复核 PDF", failed: "失败（已停止）", cancelled: "已停止"
  };
  const filters = { all: "全部", active: "进行中", waiting_auth: "等待登录", waiting_quota: "等待额度", failed: "失败", review: "需复核", done: "已完成", cancelled: "已停止" };
  const verificationLabels = { verified: "核验通过", manual: "用户已人工确认", inconclusive: "证据不足，建议人工核对", review: "需人工核对" };
  const selected = new Set();
  const expanded = new Set();
  let rows = [], visible = [], refreshTimer, refreshing = false, actionBusy = false;
  let lastSignature = "";
  const $ = id => document.getElementById(id);
  const keyOf = row => `${Number(row.libraryID)}:${String(row.itemKey)}`;
  const targets = list => list.map(row => ({ itemKey: row.itemKey, libraryID: Number(row.libraryID) }));
  const quotaLimited = row => /当日传递次数已达上限/.test(`${row.reason || ""} ${row.diagnosticMessage || ""}`);
  const matchesFilter = (row, value) => value === "all" || (value === "active" ? row.canCancel && !["waiting_auth", "waiting_quota"].includes(row.state) : row.state === value);
  const chosen = capability => visible.filter(row => selected.has(keyOf(row)) && (!capability || row[capability]));

  function html(tag, text, className = "") {
    const node = document.createElementNS(HTML_NS, tag);
    if (text !== undefined) node.textContent = String(text);
    node.className = className;
    return node;
  }
  function time(value) {
    if (!value) return "—";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString();
  }
  function reason(row) {
    if (row.state === "cancelled") return row.cancelNote || "已停止本地处理。";
    const parts = [row.reason, row.diagnosticMessage].filter(Boolean);
    return [...new Set(parts)].filter((part, index, all) => !all.some((other, i) => i !== index && other.includes(part))).join("；");
  }
  function guidance(row) {
    if (row.state === "failed" && quotaLimited(row)) return "聚联当日额度已用尽。可选择“次日自动获取”保留任务等待恢复。";
    switch (row.state) {
      case "failed": return "处理已结束。检查下方原因后重新获取，或移除本地记录。";
      case "cancelled": return "本地处理已停止；需要时可重新获取或移除记录。";
      case "review": return "点击论文检查 PDF，一致后点击“确认 PDF 正确”；也可重新自动核验。";
      case "waiting_auth": return "点击“聚联登录”。验证成功后继续等待登录的任务。";
      case "waiting_quota": return `计划 ${time(row.retryAfter)} 后自动尝试。Zotero 未运行时将在下次启动后继续；可用“停止选中”取消。`;
      case "done": return "全文已在 Zotero 中。可移除本地记录，保留 PDF。";
      case "queued": return "等待提交全文请求。";
      case "native_search": return "正在通过 Zotero 查找全文。";
      case "submitted": return "已提交聚联，等待同步远端进度。";
      case "pending": return row.unmatchedPolls >= 3 ? "多次未匹配远端记录，请到聚联核对；无需重复提交。" : "等待聚联返回全文，后台会定期检查。";
      case "downloading": return "正在下载并核验 PDF。";
      default: return "状态未知，请查看详情。";
    }
  }
  function feedback(message, error = false) {
    $("feedback").textContent = message;
    $("feedback").dataset.error = String(error);
  }
  function updateActions() {
    const count = chosen().length;
    $("selection-summary").textContent = `显示 ${visible.length} / ${rows.length} 条 · 已选 ${count} 条`;
    for (const [id, capability, label] of [
      ["retry", "canRetry", "重新获取"], ["recheck", "canRecheck", "重新核验 PDF"],
      ["schedule-quota", "canScheduleQuota", "次日自动获取"],
      ["confirm-reviewed", "canRecheck", "确认 PDF 正确"],
      ["cancel-selected", "canCancel", "停止选中"], ["clear-selected", "canClear", "移除选中记录"]
    ]) {
      const eligible = chosen(capability).length;
      $(id).textContent = `${label}（${eligible}）`;
      $(id).disabled = (actionBusy && id !== "cancel-selected") || eligible === 0;
    }
    $("deselect").disabled = count === 0;
    $("poll").disabled = actionBusy || !rows.some(row => ["submitted", "pending", "downloading"].includes(row.state));
    $("login").disabled = actionBusy;
    $("select-all").checked = visible.length > 0 && count === visible.length;
    $("select-all").indeterminate = count > 0 && count < visible.length;
    $("select-all").disabled = visible.length === 0;
  }
  function selectRow(key, checked, tr) {
    if (checked) selected.add(key); else selected.delete(key);
    tr.classList.toggle("selected", checked);
    updateActions();
  }
  function renderRow(row, body) {
    const key = keyOf(row);
    const tr = html("tr");
    tr.dataset.state = row.state;
    tr.classList.toggle("selected", selected.has(key));
    tr.classList.toggle("warning", row.diagnosticLevel === "warning" && row.canCancel);
    const checkCell = html("td");
    const checkbox = html("input");
    checkbox.type = "checkbox";
    checkbox.checked = selected.has(key);
    checkbox.setAttribute("aria-label", `选择 ${row.title || row.queryText}`);
    checkbox.addEventListener("change", () => selectRow(key, checkbox.checked, tr));
    checkCell.appendChild(checkbox);
    const state = html("td");
    state.append(html("div", labels[row.state] || row.state, "state"), html("div", row.source === "jlss" ? "聚联" : row.source === "zotero" ? "Zotero" : "尚未开始", "detail"));
    const paper = html("td");
    const link = html("button", row.title || row.queryText, "paper");
    link.type = "button";
    link.addEventListener("click", () => run(() => api.locate(row.itemKey, row.libraryID)));
    paper.appendChild(link);
    const info = html("td");
    info.appendChild(html("div", guidance(row)));
    const explanation = reason(row);
    if (explanation) info.appendChild(html("div", explanation, "detail"));
    const detailsCell = html("td");
    const toggle = html("button", expanded.has(key) ? "收起" : "详情");
    toggle.type = "button";
    toggle.setAttribute("aria-expanded", String(expanded.has(key)));
    toggle.addEventListener("click", () => {
      if (expanded.has(key)) expanded.delete(key); else expanded.add(key);
      render(true);
    });
    detailsCell.appendChild(toggle);
    tr.append(checkCell, state, paper, info, html("td", time(row.updatedAt), "detail"), detailsCell);
    body.appendChild(tr);
    if (expanded.has(key)) {
      const detailRow = html("tr");
      const detail = html("td", [
        `创建：${time(row.createdAt)}    提交：${time(row.submittedAt)}`,
        `聚联任务号：${row.taskCode || "—"}    远端状态：${row.remoteTaskStatusLabel || row.remoteTaskStatus || "—"}`,
        `匹配方式：${row.matchStrategy || "—"}    连续未匹配：${row.unmatchedPolls || 0} 次`,
        `上次匹配：${time(row.lastMatchedAt)}    上次检查：${time(row.lastCheckedAt)}`,
        `下次检查：${row.canCancel && row.state !== "waiting_auth" ? time(row.nextCheckAt) : "已停止或等待登录"}`,
        `PDF 核验：${verificationLabels[row.verification] || "尚未核验"}`,
        `额度重试计划：${time(row.retryAfter)}`,
        `说明：${explanation || "—"}`
      ].join("\n"), "details-cell");
      detail.colSpan = 6;
      detailRow.appendChild(detail);
      body.appendChild(detailRow);
    }
  }
  function render(force = false) {
    const filter = $("filter").value;
    const query = $("search").value.trim().toLocaleLowerCase();
    visible = rows.filter(row => matchesFilter(row, filter) && (!query ||
      [row.title, row.queryText, row.taskCode, reason(row)].some(value => String(value || "").toLocaleLowerCase().includes(query))));
    const visibleKeys = new Set(visible.map(keyOf));
    for (const key of selected) if (!visibleKeys.has(key)) selected.delete(key);
    const signature = JSON.stringify([visible, [...expanded], filter, query]);
    if (force || signature !== lastSignature) {
      const body = $("tasks-body");
      body.replaceChildren();
      for (const row of visible.slice().reverse()) renderRow(row, body);
      if (!visible.length) {
        const tr = html("tr"); tr.id = "empty-row";
        const td = html("td", rows.length ? "没有符合条件的任务。可切换状态或清空搜索。" : "暂无任务。请在 Zotero 中选择分类或条目，执行“获取缺失全文”。");
        td.colSpan = 6; tr.appendChild(td); body.appendChild(tr);
      }
      lastSignature = signature;
    }
    for (const option of $("filter").options) {
      option.textContent = `${filters[option.value]}（${rows.filter(row => matchesFilter(row, option.value)).length}）`;
    }
    $("active-summary").textContent = `共 ${rows.length} 条 · 进行中 ${rows.filter(row => matchesFilter(row, "active")).length} · 等待登录 ${rows.filter(row => row.state === "waiting_auth").length} · 失败 ${rows.filter(row => row.state === "failed").length} · 需复核 ${rows.filter(row => row.state === "review").length}`;
    const waitingQuota = rows.filter(row => row.state === "waiting_quota").length;
    $("active-summary").textContent += ` · 等待额度 ${waitingQuota}`;
    const quotaCount = rows.filter(row => row.state === "failed" && quotaLimited(row)).length;
    $("quota-notice").hidden = quotaCount + waitingQuota === 0;
    $("quota-notice").textContent = `${waitingQuota} 条等待额度，将在计划时间后自动尝试；${quotaCount} 条旧失败记录可选择“次日自动获取”。默认安排在本机时间次日 00:10 后，仍限额则再延至下一天。本插件无法读取准确日限或重置时间。`;
    updateActions();
  }
  async function refresh() {
    if (refreshing) return;
    refreshing = true;
    try {
      rows = api.getRows();
      render();
      const overview = await api.getOverview();
      $("summary").textContent = `获取策略：${overview.strategyLabel} · 聚联凭据：${overview.hasToken ? "已保存（不代表登录仍有效）" : "未保存"} · 远端每 ${api.pollMinutes || 5} 分钟检查；超过 ${api.pendingWarnHours || 24} 小时会提示核对`;
    }
    catch (error) { feedback(`读取任务失败：${error.message || error}`, true); }
    finally { refreshing = false; }
  }
  async function run(fn) {
    if (actionBusy) return;
    actionBusy = true; updateActions();
    try { await fn(); }
    catch (error) { feedback(`操作未完成：${error.message || error}`, true); }
    finally { actionBusy = false; await refresh(); updateActions(); }
  }
  async function retrySelected() {
    const eligible = chosen("canRetry");
    if (!eligible.length) return;
    const quota = eligible.filter(quotaLimited).length;
    if (!window.confirm(`重新获取选中的 ${eligible.length} 条失败或已停止任务？\n\n按当前获取策略执行，可能重新向聚联提交并消耗额度；已有可用 PDF 的条目会跳过。${quota ? `\n\n其中 ${quota} 条曾因当日额度用尽而失败，请确认额度已恢复。` : ""}`)) return;
    feedback(`正在重新获取 ${eligible.length} 条任务…`);
    const result = await api.retrySelected(targets(eligible));
    feedback(`重新获取结束：聚联已提交 ${result.queued}，Zotero 已获取 ${result.native}，等待额度 ${result.waitingQuota || 0}，失败 ${result.failed}，等待登录 ${result.waitingAuth}，跳过 ${result.skipped}（含已有 PDF 或超出批次上限）。`);
  }
  async function stopSelected() {
    const eligible = chosen("canCancel");
    if (!eligible.length || !window.confirm(`停止选中的 ${eligible.length} 条活动任务？\n\n仅停止 FullTextFlow 本地处理。已提交聚联的远端任务可能仍继续；停止不会退还聚联额度。`)) return;
    let count = 0;
    for (const row of eligible) if (api.cancelOne(row.itemKey, row.libraryID)) count++;
    feedback(`已停止 ${count} 条本地任务。`);
  }
  async function clearSelected() {
    const eligible = chosen("canClear");
    if (!eligible.length) return;
    const summary = ["done", "failed", "cancelled"].map(state => `${labels[state]} ${eligible.filter(row => row.state === state).length}`).join("，");
    const confirmation = window.prompt(`移除选中的 ${eligible.length} 条本地记录？\n${summary}\n\n仅移除这些任务记录，保留 Zotero PDF；不会取消聚联远端任务。活动任务和需复核记录不受影响。\n\n请输入“清理”确认：`, "");
    if (String(confirmation || "").trim() !== "清理") return;
    const count = api.clearSelected(targets(eligible));
    for (const row of eligible) selected.delete(keyOf(row));
    feedback(`已移除 ${count} 条本地记录，Zotero PDF 保留。`);
  }
  window.addEventListener("load", () => {
    $("retry").addEventListener("click", () => run(retrySelected));
    $("schedule-quota").addEventListener("click", () => run(async () => {
      const eligible = chosen("canScheduleQuota");
      if (!eligible.length || !window.confirm(`将选中的 ${eligible.length} 条额度失败记录安排为次日自动获取？\n\n本机时间次日 00:10 后按后台间隔自动尝试，可能消耗聚联额度。Zotero 未运行时，下次启动后继续。可随时停止。`)) return;
      const count = api.scheduleQuotaSelected(targets(eligible));
      feedback(`已安排 ${count} 条任务次日自动获取。`);
    }));
    $("cancel-selected").addEventListener("click", async () => {
      try { await stopSelected(); }
      catch (error) { feedback(`停止失败：${error.message || error}`, true); }
      await refresh();
    });
    $("clear-selected").addEventListener("click", () => run(clearSelected));
    $("recheck").addEventListener("click", () => run(async () => {
      const eligible = chosen("canRecheck");
      if (!eligible.length) return;
      feedback(`正在核验 ${eligible.length} 个现有 PDF…`);
      const result = await api.recheckSelected(targets(eligible));
      feedback(`核验完成：通过 ${result.verified}，仍需人工复核 ${result.review}。未重新提交聚联。`);
    }));
    $("confirm-reviewed").addEventListener("click", () => run(async () => {
      const eligible = chosen("canRecheck");
      if (!eligible.length || !window.confirm(`你是否已逐一打开并核对选中的 ${eligible.length} 个 PDF，确认与论文一致？\n\n确认后将标记为“已完成 / 用户已人工确认”。不会替换附件或重新提交聚联。`)) return;
      const result = await api.confirmReviewed(targets(eligible));
      feedback(`已人工确认 ${result.confirmed} 条；${result.missing} 条因本地附件缺失而保留需复核状态。`);
    }));
    $("poll").addEventListener("click", () => run(async () => {
      await api.poll(); feedback("已请求检查远端进度；请查看任务状态。检查进度不会重新提交任务。");
    }));
    $("login").addEventListener("click", () => run(() => api.openLogin()));
    $("duplicates").addEventListener("click", () => run(() => api.openDuplicates()));
    $("deselect").addEventListener("click", () => { selected.clear(); render(true); });
    $("select-all").addEventListener("change", () => {
      for (const row of visible) {
        if ($("select-all").checked) selected.add(keyOf(row)); else selected.delete(keyOf(row));
      }
      render(true);
    });
    for (const [id, event] of [["filter", "change"], ["search", "input"]]) {
      $(id).addEventListener(event, () => { selected.clear(); render(true); });
    }
    $("close").addEventListener("command", () => window.close());
    window.FullTextFlowTasks = { refresh };
    refresh(); refreshTimer = window.setInterval(refresh, 2000);
  }, { once: true });
  window.addEventListener("unload", () => window.clearInterval(refreshTimer), { once: true });
})();
