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
  const merging = () => $("mode").value === "merge";
  const keepers = new Map(), selected = new Set();
  function feedback(text, error = false) {
    if (closed) return;
    $("feedback").textContent = text; $("feedback").dataset.error = String(error);
  }
  const eligible = (group, file) => file.id !== keepers.get(group.id) && (merging()
    ? file.annotations > 0 && !file.mergeReason && !group.files.find(f => f.id === keepers.get(group.id))?.mergeReason
    : !file.protectedReason);
  function selection() {
    let count = 0, bytes = 0;
    for (const group of groups) for (const file of group.files) {
      if (eligible(group, file) && selected.has(file.id)) { count++; bytes += file.size; }
    }
    $("selection").textContent = `已选 ${count} 个副本 · ${mib(bytes)}（逻辑大小）`;
    $("trash").disabled = busy || !count;
    $("trash").textContent = merging() ? "合并批注并清理副本…" : "将选中副本移入回收站…";
    $("mode").disabled = busy; $("history").disabled = busy;
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
        const blocked = merging() ? file.mergeReason : file.protectedReason;
        if (blocked) { const reason = create("div", blocked); reason.className = "reason"; details.append(reason); }
        if (merging() && file.annotations > 0 && !blocked) details.append(create("div", "可迁移 Zotero 批注；执行前还会检查内嵌批注"));
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
    const merge = merging(), phrase = merge ? "合并批注并清理" : "移入回收站";
    const annotationCount = requests.reduce((sum, request) => sum + request.group.files.filter(file => request.ids.includes(file.id)).reduce((s, f) => s + f.annotations, 0), 0);
    const preview = requests.map(request => `${request.group.title}\n保留：${request.group.files.find(file => file.id === request.keeper).key}；副本：${request.group.files.filter(file => request.ids.includes(file.id)).map(file => file.key).join("、")}`).join("\n");
    const answer = window.prompt(merge
      ? `将 ${requests.length} 组、${count} 个副本的 ${annotationCount} 条批注迁入指定保留附件，核验成功后将副本移入回收站？\n${preview}\n\n不自动删重；不改写已有笔记中的旧附件链接。请关闭本组所有 PDF 阅读器。\n操作会同步；合并记录只存本机。撤销请用“合并记录 / 恢复”，不要仅手动恢复 PDF，也不要清空回收站。\n\n请输入“${phrase}”确认：`
      : `将 ${requests.length} 组中的 ${count} 个 PDF 副本移入 Zotero 回收站？\n每组指定的保留附件不动；带批注、笔记的附件受保护。\n可从回收站恢复；会随 Zotero 同步。请先关闭正在编辑的 PDF。\n\n请输入“${phrase}”确认：`, "");
    if (answer !== phrase) return;
    busy = true; render(); let moved = 0, annotations = 0; const errors = [], warnings = [];
    try {
      for (const request of requests) {
        if (closed) break;
        feedback(`正在重新核验并处理，已移入回收站 ${moved} 个…`);
        try {
          if (merge) {
            const result = await api.merge(request.group.id, request.keeper, request.ids, answer);
            moved += result.moved; annotations += result.annotations;
            if (result.warning) warnings.push(result.warning);
          } else moved += await api.trash(request.group.id, request.keeper, request.ids, answer);
          groups = groups.filter(group => group.id !== request.group.id);
        } catch (error) { errors.push(`${request.group.title}：${error.message || error}`); }
      }
      feedback(`${merge ? `已迁移并核验 ${annotations} 条批注。` : ""}已移入回收站 ${moved} 个副本；${errors.length} 组未处理。未清空回收站。\n${errors.join("\n")}\n${warnings.join("\n")}${moved ? "\n已处理组已移出列表；如仅清理部分副本，可重新扫描。" : ""}`, errors.length > 0 || warnings.length > 0);
    } finally { busy = false; selected.clear(); render(); }
  }
  async function history() {
    if (busy) return;
    busy = true; render();
    try {
      const records = await api.history();
      $("history-list").hidden = false; $("history-list").replaceChildren();
      for (const record of records) {
        const row = create("div", `${record.createdAt} · ${record.title} · ${record.annotations} 条批注 / ${record.copies} 个副本 · ${record.status === "restored" ? "已恢复" : record.status === "committed" ? "已合并" : "待核对（可能未执行或已完成）"} `);
        if (record.status !== "restored") {
          const restore = button("核对并恢复此合并", async () => {
            if (busy) return;
            const answer = window.prompt(`恢复“${record.title}”的这一次合并？\n将原副本恢复，并将本次迁移的 ${record.annotations} 条批注移回原附件。若批注被修改、附件缺失或已手动恢复，将停止；不会覆盖后续修改。\n\n请关闭相关 PDF 阅读器，并输入“恢复合并”：`, "");
            if (answer !== "恢复合并") return;
            busy = true; render();
            try { feedback(await api.restore(record.id, answer)); }
            catch (error) { feedback(String(error.message || error), true); }
            finally {
              groups = []; selected.clear(); keepers.clear(); busy = false;
              $("history-list").replaceChildren(); $("history-list").hidden = true; render();
            }
          });
          restore.disabled = false; row.append(restore);
        }
        $("history-list").append(row);
      }
      if (!records.length) $("history-list").append(create("div", "本机当前资料库没有合并记录。"));
    } catch (error) { feedback(String(error.message || error), true); }
    finally { busy = false; render(); }
  }
  window.addEventListener("load", () => {
    $("mode").value = "trash";
    $("scope-label").textContent = `${api.scopeLabel} · 打开时选中 ${api.selectedCount} 个条目`;
    $("scope").value = api.selectedCount ? "selected" : "library";
    $("scan").addEventListener("click", scan);
    $("cancel").addEventListener("click", () => { api.cancel(); $("cancel").disabled = true; feedback("正在取消扫描…"); });
    $("choose").addEventListener("click", () => { for (const group of groups) for (const file of group.files) if (eligible(group, file)) selected.add(file.id); render(); });
    $("clear").addEventListener("click", () => { selected.clear(); render(); });
    $("trash").addEventListener("click", trash);
    $("mode").addEventListener("change", () => { selected.clear(); render(); });
    $("history").addEventListener("click", history);
    selection();
  }, { once: true });
  window.addEventListener("unload", () => { closed = true; api.cancel(); }, { once: true });
})();
