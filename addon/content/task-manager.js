/* global window, document */
(() => {
  const api = window.arguments?.[0]?.wrappedJSObject;
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

  let refreshTimer = null;

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

  function cell(value) {
    const c = document.createXULElement("listcell");
    c.setAttribute("label", String(value || ""));
    c.setAttribute("crop", "end");
    return c;
  }

  function rowReason(row) {
    if (row.state === "cancelled") return row.cancelNote || row.reason || "已取消";
    if (row.remoteTaskStatusLabel && ["submitted", "pending", "downloading"].includes(row.state)) {
      return row.reason ? `${row.remoteTaskStatusLabel}；${row.reason}` : row.remoteTaskStatusLabel;
    }
    return row.reason || "";
  }

  function statusDetail(row) {
    if (row.state === "pending" && row.remoteTaskStatusLabel) return row.remoteTaskStatusLabel;
    if (row.state === "submitted") return "等待首次同步聚联任务列表";
    if (row.state === "downloading") return row.remoteTaskStatusLabel || "聚联已返回全文";
    return progress[row.state]?.[1] || "";
  }

  function selectedKeys() {
    const box = document.getElementById("tasks");
    const selected = box.selectedItems
      ? Array.from(box.selectedItems)
      : Array.from(box.children || []).filter(item => item.selected || item.getAttribute("selected") === "true");
    return selected.map(item => ({
      itemKey: item.getAttribute("data-item-key"),
      libraryID: Number(item.getAttribute("data-library-id"))
    })).filter(x => x.itemKey && Number.isFinite(x.libraryID));
  }

  function terminal(state) {
    return ["done", "review", "failed", "cancelled"].includes(state);
  }

  async function refresh() {
    const rows = api?.getRows?.() || [];
    const box = document.getElementById("tasks");
    const selectedBefore = new Set(selectedKeys().map(x => `${x.libraryID}:${x.itemKey}`));
    while (box.itemCount) box.removeItemAt(0);

    const counts = {};
    for (const row of rows) counts[row.state] = (counts[row.state] || 0) + 1;
    for (const row of rows.slice().reverse()) {
      const item = document.createXULElement("listitem");
      item.setAttribute("data-item-key", row.itemKey);
      item.setAttribute("data-library-id", String(row.libraryID));
      item.setAttribute("data-state", row.state);
      const elapsedFrom = row.submittedAt || row.createdAt;
      const remote = row.taskCode
        ? `${row.taskCode}${row.remoteTaskStatus ? ` / ${row.remoteTaskStatus}` : ""}`
        : row.remoteTaskStatusLabel || "";
      item.append(
        cell(labels[row.state] || row.state),
        cell(progress[row.state]?.[0] || ""),
        cell(statusDetail(row)),
        cell(row.source === "zotero" ? "Zotero" : row.source === "jlss" ? "聚联" : ""),
        cell(row.title || row.queryText),
        cell(remote),
        cell(elapsed(elapsedFrom)),
        cell(shortTime(row.lastCheckedAt)),
        cell(shortTime(row.nextCheckAt)),
        cell(row.verification || ""),
        cell(rowReason(row))
      );
      box.append(item);
      if (selectedBefore.has(`${row.libraryID}:${row.itemKey}`)) item.setAttribute("selected", "true");
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
    document.getElementById("summary").textContent = summaryParts.join(" · ");

    const detailParts = ["native_search", "queued", "submitted", "pending", "downloading", "waiting_auth"]
      .filter(k => counts[k])
      .map(k => `${labels[k]} ${counts[k]}`);
    document.getElementById("active-summary").textContent = detailParts.length
      ? `当前：${detailParts.join(" · ")}`
      : "当前没有进行中的任务。";
  }

  async function busy(button, fn) {
    button.disabled = true;
    try { await fn(); }
    finally { button.disabled = false; await refresh(); }
  }

  async function cancelSelected() {
    const selected = selectedKeys();
    if (!selected.length) {
      window.alert("请先选择要取消的任务。可按 Ctrl/Command 多选。");
      return;
    }
    const ok = window.confirm(`确定取消选中的 ${selected.length} 条任务吗？\n\n如果任务已经提交聚联，只会停止 FullTextFlow 本地轮询和下载；聚联远端任务可能仍继续。`);
    if (!ok) return;
    for (const row of selected) api.cancelOne(row.itemKey, row.libraryID);
    await refresh();
  }

  async function cancelAll() {
    const ok = window.confirm("确定取消全部进行中的任务吗？\n\n已提交聚联的远端任务可能仍继续，但 FullTextFlow 将停止轮询和下载。");
    if (!ok) return;
    api.cancelAll();
    await refresh();
  }

  window.addEventListener("load", () => {
    document.getElementById("poll").addEventListener("command", e => busy(e.currentTarget, () => api.poll()));
    document.getElementById("retry").addEventListener("command", e => busy(e.currentTarget, () => api.retryProblems()));
    document.getElementById("cancel-selected").addEventListener("command", () => cancelSelected());
    document.getElementById("cancel-all").addEventListener("command", () => cancelAll());
    document.getElementById("clear-finished").addEventListener("command", async () => { api.clearFinished(); await refresh(); });
    document.getElementById("close").addEventListener("command", () => window.close());
    window.FullTextFlowTasks = { refresh };
    refresh();
    refreshTimer = window.setInterval(() => refresh(), 2000);
  }, { once: true });

  window.addEventListener("unload", () => {
    if (refreshTimer) window.clearInterval(refreshTimer);
  }, { once: true });
})();
