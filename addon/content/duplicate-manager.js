(function () {
  "use strict";
  const api = window.arguments?.[0]?.wrappedJSObject;
  const $ = id => document.getElementById(id);
  const create = (tag, text) => {
    const node = document.createElementNS("http://www.w3.org/1999/xhtml", tag);
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const mib = bytes => `${(bytes / 1048576).toFixed(2)} MiB`;
  let groups = [], busy = false, closed = false;
  const keepers = new Map(), selected = new Set();
  function feedback(text, error = false) {
    if (closed) return;
    $("feedback").textContent = text; $("feedback").dataset.error = String(error);
  }
  const eligible = (group, file) => file.id !== keepers.get(group.id) && !file.protectedReason;
  function selection() {
    let count = 0, bytes = 0;
    for (const group of groups) for (const file of group.files) {
      if (eligible(group, file) && selected.has(file.id)) { count++; bytes += file.size; }
    }
    $("selection").textContent = `已选 ${count} 个副本 · ${mib(bytes)}（逻辑大小）`;
    $("trash").disabled = busy || !count;
    $("scan").disabled = busy; $("scope").disabled = busy;
    $("choose").disabled = busy || !groups.length;
    $("clear").disabled = busy || !selected.size;
  }
  function button(text, action) {
    const node = create("button", text); node.disabled = busy;
    node.addEventListener("click", async () => { try { await action(); } catch (error) { feedback(String(error.message || error), true); } });
    return node;
  }
  function render() {
    if (closed) return;
    $("groups").replaceChildren();
    for (const group of groups) {
      const section = create("section"); section.className = "group";
      const heading = create("h3", group.title);
      const hash = create("div", `SHA-256：${group.files[0].hash}`); hash.className = "hash";
      section.append(heading, button("定位条目", () => api.locate(group.parentID)), hash);
      const table = create("table"), head = create("thead"), header = create("tr");
      for (const label of ["保留", "清理", "附件 / 路径", "大小 / 批注 / 笔记", "核对"]) header.append(create("th", label));
      head.append(header); table.append(head);
      const body = create("tbody");
      for (const file of group.files) {
        const row = create("tr"), keepCell = create("td"), selectCell = create("td");
        const keep = create("input"); keep.type = "radio"; keep.name = `keep-${group.id}`;
        keep.checked = keepers.get(group.id) === file.id; keep.disabled = busy;
        keep.setAttribute("aria-label", `保留 ${file.key}`);
        keep.addEventListener("change", () => {
          keepers.set(group.id, file.id);
          // Changing the keeper resets this group's deletion choices.
          for (const member of group.files) selected.delete(member.id);
          render();
        });
        keepCell.append(keep);
        const check = create("input"); check.type = "checkbox";
        check.checked = selected.has(file.id) && eligible(group, file);
        check.disabled = busy || !eligible(group, file);
        check.setAttribute("aria-label", `清理 ${file.key}`);
        check.addEventListener("change", () => { if (check.checked) selected.add(file.id); else selected.delete(file.id); selection(); });
        selectCell.append(check);
        const details = create("td"); details.append(create("div", `${file.title} [${file.key}]`));
        const path = create("div", file.path); path.className = "path"; details.append(path);
        if (file.protectedReason) { const reason = create("div", file.protectedReason); reason.className = "reason"; details.append(reason); }
        const counts = create("td", `${mib(file.size)} · 批注 ${file.annotations} · 笔记 ${file.notes}`);
        const open = create("td"); open.append(button("打开 PDF", () => api.open(file.id)));
        row.append(keepCell, selectCell, details, counts, open); body.append(row);
      }
      table.append(body); section.append(table); $("groups").append(section);
    }
    if (!groups.length) $("groups").append(create("p", "没有可显示的同条目重复组。请扫描，并查看上方扫描范围及跳过信息。"));
    selection();
  }
  async function scan() {
    if (busy) return;
    busy = true; groups = []; keepers.clear(); selected.clear(); render();
    $("cancel").disabled = false; $("coverage").textContent = "";
    feedback("正在读取条目…");
    try {
      const result = await api.scan($("scope").value, text => feedback(text));
      groups = result.groups;
      for (const group of groups) keepers.set(group.id, (group.files.find(file => file.annotations || file.notes) || group.files[0]).id);
      feedback(`扫描完成：${result.checked} 个条目，${groups.length} 组内容相同的 PDF。尚未修改附件。`);
      $("coverage").textContent = result.skipped.length ? `跳过 ${result.skipped.length} 项（未纳入去重）：\n${result.skipped.join("\n")}` : "未报告本地文件读取错误。未下载云端缺失文件。";
    } catch (error) { feedback(String(error.message || error), true); }
    finally { busy = false; $("cancel").disabled = true; render(); }
  }
  async function trash() {
    if (busy) return;
    const requests = groups.map(group => ({ group, keeper: keepers.get(group.id),
      ids: group.files.filter(file => selected.has(file.id) && eligible(group, file)).map(file => file.id) })).filter(request => request.ids.length);
    if (!requests.length) return;
    const count = requests.reduce((sum, request) => sum + request.ids.length, 0);
    const answer = window.prompt(`将 ${requests.length} 组中的 ${count} 个 PDF 副本移入 Zotero 回收站？\n每组指定的保留附件不动；带批注、笔记的附件受保护。\n可从回收站恢复；会随 Zotero 同步。请先关闭正在编辑的 PDF。\n\n请输入“移入回收站”确认：`, "");
    if (answer !== "移入回收站") return;
    busy = true; render(); let moved = 0; const errors = [];
    try {
      for (const request of requests) {
        if (closed) break;
        feedback(`正在重新核验并处理，已移入回收站 ${moved} 个…`);
        try {
          moved += await api.trash(request.group.id, request.keeper, request.ids, answer);
          groups = groups.filter(group => group.id !== request.group.id);
        } catch (error) { errors.push(`${request.group.title}：${error.message || error}`); }
      }
      feedback(`已移入回收站 ${moved} 个副本；${errors.length} 组未处理。未清空回收站。\n${errors.join("\n")}${moved ? "\n已处理组已移出列表；如仅清理部分副本，可重新扫描。" : ""}`, errors.length > 0);
    } finally { busy = false; selected.clear(); render(); }
  }
  window.addEventListener("load", () => {
    $("scope-label").textContent = `${api.scopeLabel} · 打开时选中 ${api.selectedCount} 个条目`;
    $("scope").value = api.selectedCount ? "selected" : "library";
    $("scan").addEventListener("click", scan);
    $("cancel").addEventListener("click", () => { api.cancel(); $("cancel").disabled = true; feedback("正在取消扫描…"); });
    $("choose").addEventListener("click", () => { for (const group of groups) for (const file of group.files) if (eligible(group, file)) selected.add(file.id); render(); });
    $("clear").addEventListener("click", () => { selected.clear(); render(); });
    $("trash").addEventListener("click", trash);
    selection();
  }, { once: true });
  window.addEventListener("unload", () => { closed = true; api.cancel(); }, { once: true });
})();
