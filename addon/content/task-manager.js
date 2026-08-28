/* global window, document */
(() => {
  const api = window.arguments?.[0]?.wrappedJSObject;
  const HTML_NS = "http://www.w3.org/1999/xhtml";

  const labels = {
    queued: "等待提交",
    native_search: "Zotero 查找",
    waiting_auth: "等待聚联登录",
    submitted: "聚联已提交",
    pending: "聚联查找中",
    downloading: "下载/核验中",
    done: "完成",
    review: "需复核",
    failed: "失败",
    cancelled: "已取消"
  };

  const progress = {
    queued: ["1/5", "等待进入全文获取流程"],
    native_search: ["1/5", "正在使用 Zotero / OA / Resolver 查找全文"],
    waiting_auth: ["阻塞", "等待聚联登录"],
    submitted: ["2/5", "已提交聚联，等待远端任务建立"],
    pending: ["3/5", "聚联正在自动或人工查找"],
    downloading: ["4/5", "PDF 已可用，正在下载并核验"],
    done: ["5/5", "全文已挂回 Zotero"],
    review: ["5/5", "PDF 已获取，但需要人工核对"],
    failed: ["终止", "任务失败，可重试"],
    cancelled: ["终止", "已停止本地处理"]
  };

  const matchLabels = {
    uuid: "UUID",
    task_code: "任务号",
    query_exact: "提交内容",
    doi_exact: "DOI 精确",
    pmid_exact: "PMID 精确",
    title_exact: "标题精确",
    doi_contained: "DOI 包含",
    pmid_contained: "PMID 包含",
    title_similarity: "标题相似度"
  };

  let refreshTimer = null;
  const selected = new Set();
  let rowMap = new Map();

  function html(tag) {
    return document.createElementNS(HTML_NS, tag);
  }

  function keyOf(row) {
    return `${Number(row.libraryID)}:${String(row.itemKey)}`;
  }

  function terminal(state) {
    return ["done", "review", "failed", "cancelled"].includes(state);
  }

  function shortTime(value) {
    if (!value) return "";
    try { return new Date(value).toLocaleString(); }
    catch (_) { return String(value); }
  }

  function elapsed(value) {
    if (!value) return "";
    const start = new Date(value).getTime();
    if (!Number.isFinite(start)) return "";
    const ms = Math.max(0, Date.now() - start);
    const sec = Math.floor(ms / 1000);
    if (sec < 60) return `${sec}秒`;
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min}分${sec % 60}秒`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr}小时${min % 60}分`;
    const day = Math.floor(hr / 24);
    return `${day}天${hr % 24}小时`;
  }

  function rowReason(row) {
    if (row.state === "cancelled") return row.cancelNote || row.reason || "已取消";
    const parts = [];
    if (row.diagnosticMessage) parts.push(row.diagnosticMessage);
    if (row.reason && !parts.includes(row.reason)) parts.push(row.reason);
    if (!parts.length && row.remoteTaskStatusLabel && ["submitted", "pending", "downloading"].includes(row.state)) {
      parts.push(row.remoteTaskStatusLabel);
    }
    return parts.join("；");
  }

  function statusDetail(row) {
    if (row.diagnosticLevel === "warning") {
      if (row.unmatchedPolls >= 3) return `⚠ 连续 ${row.unmatchedPolls} 次未匹配远端任务`;
      if (row.state === "pending") return "⚠ 聚联任务长时间处理中";
    }
    if (row.state === "pending" && row.remoteTaskStatusLabel) return row.remoteTaskStatusLabel;
    if (row.state === "submitted") return "等待首次同步聚联任务列表";
    if (row.state === "downloading") return row.remoteTaskStatusLabel || "聚联已返回全文";
    return progress[row.state]?.[1] || "";
  }

  function matchDetail(row) {
    if (row.matchStrategy) return matchLabels[row.matchStrategy] || row.matchStrategy;
    if (row.unmatchedPolls > 0) return `未匹配 ×${row.unmatchedPolls}`;
    if (["submitted", "pending"].includes(row.state)) return "等待匹配";
    return "";
  }

  function cell(value, className = "compact") {
    const td = html("td");
    td.className = className;
    const text = String(value || "");
    td.textContent = text;
    if (text) td.title = text;
    return td;
  }

  function selectedKeys() {
    const out = [];
    for (const key of selected) {
      const row = rowMap.get(key);
      if (!row || terminal(row.state)) continue;
      out.push({ itemKey: String(row.itemKey), libraryID: Number(row.libraryID) });
    }
    return out;
  }

  function updateSelectAllState() {
    const control = document.getElementById("select-all");
    if (!control) return;
    const activeKeys = Array.from(rowMap.entries())
      .filter(([, row]) => !terminal(row.state))
      .map(([key]) => key);
    const selectedCount = activeKeys.filter(key => selected.has(key)).length;
    control.checked = activeKeys.length > 0 && selectedCount === activeKeys.length;
    control.indeterminate = selectedCount > 0 && selectedCount < activeKeys.length;
    control.disabled = activeKeys.length === 0;
  }

  function setRowSelected(tr, checkbox, key, checked) {
    if (checked) selected.add(key);
    else selected.delete(key);
    checkbox.checked = checked;
    tr.classList.toggle("selected", checked);
    updateSelectAllState();
  }

  function renderRow(row) {
    const key = keyOf(row);
    const tr = html("tr");
    tr.dataset.itemKey = String(row.itemKey);
    tr.dataset.libraryId = String(row.libraryID);
    tr.dataset.state = String(row.state);
    if (row.diagnosticLevel === "warning") tr.classList.add("warning");
    if (row.state === "cancelled") tr.classList.add("cancelled");
    if (selected.has(key)) tr.classList.add("selected");

    const selectTd = html("td");
    selectTd.className = "center compact";
    const checkbox = html("input");
    checkbox.type = "checkbox";
    checkbox.checked = selected.has(key);
    checkbox.disabled = terminal(row.state);
    checkbox.title = terminal(row.state) ? "终止状态不可取消" : "选择此任务";
    checkbox.addEventListener("click", event => event.stopPropagation());
    checkbox.addEventListener("change", () => setRowSelected(tr, checkbox, key, checkbox.checked));
    selectTd.appendChild(checkbox);

    const elapsedFrom = row.submittedAt || row.createdAt;
    const remote = row.taskCode
      ? `${row.taskCode}${row.remoteTaskStatus ? ` / ${row.remoteTaskStatus}` : ""}`
      : row.remoteTaskStatusLabel || "";

    tr.append(
      selectTd,
      cell(labels[row.state] || row.state),
      cell(progress[row.state]?.[0] || ""),
      cell(statusDetail(row), "wrap"),
      cell(row.source === "zotero" ? "Zotero" : row.source === "jlss" ? "聚联" : ""),
      cell(row.title || row.queryText, "wrap"),
      cell(remote, "wrap"),
      cell(matchDetail(row)),
      cell(elapsed(elapsedFrom)),
      cell(shortTime(row.lastMatchedAt)),
      cell(shortTime(row.lastCheckedAt)),
      cell(shortTime(row.nextCheckAt)),
      cell(row.verification || ""),
      cell(rowReason(row), "wrap")
    );

    if (!terminal(row.state)) {
      tr.addEventListener("click", event => {
        if (event.target?.tagName?.toLowerCase() === "input") return;
        setRowSelected(tr, checkbox, key, !selected.has(key));
      });
    }
    return tr;
  }

  async function refresh() {
    const rows = api?.getRows?.() || [];
    rowMap = new Map(rows.map(row => [keyOf(row), row]));
    for (const key of Array.from(selected)) {
      if (!rowMap.has(key)) selected.delete(key);
    }

    const body = document.getElementById("tasks-body");
    while (body.firstChild) body.firstChild.remove();

    const counts = {};
    for (const row of rows) counts[row.state] = (counts[row.state] || 0) + 1;
    const warningCount = rows.filter(row => row.diagnosticLevel === "warning" && !terminal(row.state)).length;

    if (!rows.length) {
      const tr = html("tr");
      tr.id = "empty-row";
      const td = html("td");
      td.colSpan = 14;
      td.textContent = "暂无任务。";
      tr.appendChild(td);
      body.appendChild(tr);
    }
    else {
      for (const row of rows.slice().reverse()) body.appendChild(renderRow(row));
    }

    const activeCount = rows.filter(r => !terminal(r.state)).length;
    const summaryParts = [
      `总计 ${rows.length}`,
      `进行中 ${activeCount}`,
      `完成 ${counts.done || 0}`,
      `需复核 ${counts.review || 0}`,
      `失败 ${counts.failed || 0}`,
      `已取消 ${counts.cancelled || 0}`
    ];
    if (warningCount) summaryParts.push(`⚠ 需关注 ${warningCount}`);
    document.getElementById("summary").textContent = summaryParts.join(" · ");

    const detailParts = ["native_search", "queued", "submitted", "pending", "downloading", "waiting_auth"]
      .filter(k => counts[k])
      .map(k => `${labels[k]} ${counts[k]}`);
    document.getElementById("active-summary").textContent = detailParts.length
      ? `当前：${detailParts.join(" · ")}。远端处理中超过 ${api.pendingWarnHours || 24} 小时会提示核对，但不会自动判定失败。`
      : "当前没有进行中的任务。";

    updateSelectAllState();
  }

  async function busy(button, fn) {
    button.disabled = true;
    try { await fn(); }
    finally { button.disabled = false; await refresh(); }
  }

  async function cancelSelected() {
    const rows = selectedKeys();
    if (!rows.length) {
      window.alert("请先勾选要取消的进行中任务。");
      return;
    }
    const ok = window.confirm(`确定取消选中的 ${rows.length} 条任务吗？\n\n如果任务已经提交聚联，只会停止 FullTextFlow 本地轮询和下载；聚联远端任务可能仍继续。`);
    if (!ok) return;
    for (const row of rows) {
      api.cancelOne(row.itemKey, row.libraryID);
      selected.delete(`${row.libraryID}:${row.itemKey}`);
    }
    await refresh();
  }

  async function cancelAll() {
    const ok = window.confirm("确定取消全部进行中的任务吗？\n\n已提交聚联的远端任务可能仍继续，但 FullTextFlow 将停止轮询和下载。");
    if (!ok) return;
    api.cancelAll();
    selected.clear();
    await refresh();
  }

  function toggleSelectAll() {
    const control = document.getElementById("select-all");
    const shouldSelect = Boolean(control.checked);
    for (const [key, row] of rowMap.entries()) {
      if (terminal(row.state)) continue;
      if (shouldSelect) selected.add(key);
      else selected.delete(key);
    }
    refresh();
  }

  window.addEventListener("load", () => {
    document.getElementById("poll").addEventListener("command", e => busy(e.currentTarget, () => api.poll()));
    document.getElementById("retry").addEventListener("command", e => busy(e.currentTarget, () => api.retryProblems()));
    document.getElementById("cancel-selected").addEventListener("command", () => cancelSelected());
    document.getElementById("cancel-all").addEventListener("command", () => cancelAll());
    document.getElementById("clear-finished").addEventListener("command", async () => { api.clearFinished(); selected.clear(); await refresh(); });
    document.getElementById("close").addEventListener("command", () => window.close());
    document.getElementById("select-all").addEventListener("change", () => toggleSelectAll());
    window.FullTextFlowTasks = { refresh };
    refresh();
    refreshTimer = window.setInterval(() => refresh(), 2000);
  }, { once: true });

  window.addEventListener("unload", () => {
    if (refreshTimer) window.clearInterval(refreshTimer);
  }, { once: true });
})();
