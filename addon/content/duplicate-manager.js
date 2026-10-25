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
  // Display-only text extraction. Never insert note HTML into the document.
  const noteText = html => String(html).replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<\/?(?:p|div|br|li|h[1-6]|tr)\b[^>]*>/gi, "\n").replace(/<[^>]*>/g, "")
    .replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (entity, name) => {
      const named = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
      if (name[0] !== "#") return named[name.toLowerCase()];
      const code = name[1].toLowerCase() === "x" ? parseInt(name.slice(2), 16) : Number(name.slice(1));
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : entity;
    }).replace(/\n{3,}/g, "\n\n").trim();
  let groups = [], busy = false, closed = false;
  const mode = () => $("mode").value;
  const keepers = new Map(), selected = new Set();
  function feedback(text, error = false) {
    if (closed) return;
    $("feedback").textContent = text; $("feedback").dataset.error = String(error);
  }
  function blockedReason(group, file) {
    if (file.id === keepers.get(group.id)) return "";
    if (mode() === "trash" || !file.annotations) return file.protectedReason;
    const keeper = group.files.find(f => f.id === keepers.get(group.id));
    return file.mergeReason || (keeper?.mergeReason ? `保留附件不支持合并：${keeper.mergeReason}` : "");
  }
  const eligible = (group, file) => file.id !== keepers.get(group.id)
    && !(mode() === "merge" && !file.annotations) && !blockedReason(group, file);
  function selection() {
    let count = 0, bytes = 0, annotations = 0, mergeCopies = 0, available = 0, blocked = 0;
    for (const group of groups) for (const file of group.files) {
      if (file.id === keepers.get(group.id)) continue;
      if (eligible(group, file)) available++; else blocked++;
      if (eligible(group, file) && selected.has(file.id)) {
        count++; bytes += file.size; annotations += file.annotations;
        if (file.annotations) mergeCopies++;
      }
    }
    $("summary").textContent = `发现 ${groups.length} 组 · 可选 ${available} 个副本 · 暂不处理 ${blocked} 个副本（原因见列表）`;
    $("selection").textContent = `已选 ${count} 个副本 · 直接清理 ${count - mergeCopies} 个 · 先合并 ${mergeCopies} 个 / ${annotations} 条批注 · ${mib(bytes)}（逻辑大小）`;
    $("selected-preview").textContent = groups.map(group => {
      const copies = group.files.filter(file => selected.has(file.id) && eligible(group, file));
      return copies.length ? `${group.title}\n保留：${group.files.find(f => f.id === keepers.get(group.id)).key}；副本：${copies.map(f => f.key).join("、")}` : "";
    }).filter(Boolean).join("\n\n") || "尚未勾选副本。";
    $("trash").disabled = busy || !count;
    $("trash").textContent = annotations ? "③ 合并批注并移入回收站…" : "③ 一键移入回收站…";
    $("next-step").textContent = busy ? "正在处理，请稍候…" : count
      ? "下一步：点击③，核对汇总后确认。无需逐组操作。"
      : available ? "下一步：点击②一键勾选，或在列表中手动选择副本。"
      : groups.length ? "当前没有可安全处理的副本。请查看原因；不要强制删除带笔记的附件。"
      : "请先点击①扫描重复 PDF；扫描和勾选都不会修改附件。";
    $("mode").disabled = busy; $("history").disabled = busy;
    $("scan").disabled = busy; $("scope").disabled = busy;
    $("choose").disabled = busy || !available;
    $("clear").disabled = busy || !selected.size;
  }
  function button(text, action) {
    const node = create("button", text); node.disabled = busy;
    node.addEventListener("click", async () => { try { await action(); } catch (error) { feedback(String(error.message || error), true); } });
    return node;
  }
  async function showNotes(group) {
    if (busy) return;
    busy = true; render();
    try {
      const files = await api.notes(group.id);
      if (closed) return;
      const panel = $("notes-panel"); panel.replaceChildren(); panel.hidden = false;
      panel.append(create("h3", `笔记原文对照 · ${group.title}`));
      const close = button("关闭笔记对照", () => { panel.hidden = true; panel.replaceChildren(); });
      close.disabled = false; panel.append(close);
      panel.append(create("p", "只读查看，不合并或删除笔记。显示正文，可展开 HTML 原文；不加载图片或执行脚本。高亮表示与保留附件相同行号不同，不代表内容可安全删除。图片和格式请回 Zotero 核对。"));
      const original = files.find(file => file.key === group.files.find(f => f.id === keepers.get(group.id))?.key);
      const raw = file => file.notes.map(note => `${note.deleted ? "[回收站中的笔记]" : "[笔记]"}\n${note.html}`).join("\n\n");
      const content = file => file.notes.map(note => `${note.deleted ? "[回收站中的笔记]" : "[笔记]"}\n${noteText(note.html)}`).join("\n\n");
      const baseline = original ? content(original).split("\n") : [];
      const columns = create("div"); columns.className = "note-columns";
      for (const file of files) {
        const column = create("section"); column.className = "note-column";
        column.append(create("h4", `${file.key}${file === original ? "（保留）" : ""} · ${file.notes.length} 条笔记`));
        column.append(create("div", file.notes.length ? `笔记编号：${file.notes.map(n => n.key).join("、")}` : "无附件笔记"));
        if (file !== original) column.append(create("p", raw(file) === raw(original || { notes: [] }) ? "笔记原文与保留附件完全相同（不自动清理）" : "笔记原文不同，请人工核对"));
        const pre = create("pre");
        content(file).split("\n").forEach((line, index) => {
          const span = create("span", `${index + 1}  ${line}\n`);
          if (file !== original && line !== baseline[index]) span.className = "note-changed";
          pre.append(span);
        });
        const source = create("details"); source.append(create("summary", "展开笔记 HTML 原文（只读）"), create("pre", raw(file)));
        column.append(pre, source); columns.append(column);
      }
      panel.append(columns);
    } catch (error) { feedback(String(error.message || error), true); }
    finally { busy = false; render(); }
  }
  function render() {
    if (closed) return;
    $("groups").replaceChildren();
    const categories = [
      { label: "可直接清理", groups: [] }, { label: "需合并批注", groups: [] }, { label: "需人工处理", groups: [] }
    ];
    for (const group of groups) {
      const available = group.files.filter(file => eligible(group, file));
      categories[available.some(file => file.annotations) ? 1 : available.length ? 0 : 2].groups.push(group);
    }
    const containers = new Map();
    for (const [index, category] of categories.entries()) {
      const section = create("details"); section.open = index !== 2 || !categories[0].groups.length && !categories[1].groups.length;
      section.className = "result-category";
      section.append(create("summary", `${category.label}（${category.groups.length} 组）`));
      if (index === 2) section.append(create("p", "此分区当前不执行清理。含笔记、外部批注等情况需人工核对；切换处理方式可能改变分区。"));
      if (!category.groups.length) section.append(create("p", "暂无此类重复组。"));
      for (const group of category.groups) containers.set(group.id, section);
      $("groups").append(section);
    }
    for (const group of groups) {
      const section = create("section"); section.className = "group";
      const heading = create("h3", group.title);
      const hash = create("div", `SHA-256：${group.files[0].hash}`); hash.className = "hash";
      section.append(heading, button("定位条目", () => api.locate(group.parentID)), hash);
      if (group.files.some(file => file.notes)) section.append(button("查看笔记差异（只读）", () => showNotes(group)));
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
          $("notes-panel").hidden = true; $("notes-panel").replaceChildren();
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
        const blocked = blockedReason(group, file);
        if (blocked) { const reason = create("div", blocked); reason.className = "reason"; details.append(reason); }
        if (file.id === keepers.get(group.id)) details.append(create("div", "保留此 PDF 及其原有批注 / 笔记"));
        else if (eligible(group, file)) details.append(create("div", file.annotations
          ? "先合并批注，核验成功后移入回收站；执行前检查内嵌批注"
          : "无批注和笔记，直接移入回收站"));
        else if (mode() === "merge" && !file.annotations && !blocked) details.append(create("div", "无批注：请选择智能处理或仅清理无批注副本"));
        const counts = create("td", `${mib(file.size)} · 批注 ${file.annotations} · 笔记 ${file.notes}`);
        const open = create("td"); open.append(button("打开 PDF", () => api.open(file.id)));
        row.append(keepCell, selectCell, details, counts, open); body.append(row);
      }
      table.append(body); section.append(table); containers.get(group.id).append(section);
    }
    if (!groups.length) $("groups").append(create("p", "没有可显示的同条目重复组。请扫描，并查看上方扫描范围及跳过信息。"));
    selection();
  }
  async function scan() {
    if (busy) return;
    busy = true; groups = []; keepers.clear(); selected.clear(); render();
    $("notes-panel").hidden = true; $("notes-panel").replaceChildren();
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
    const annotationCount = requests.reduce((sum, request) => sum + request.group.files.filter(file => request.ids.includes(file.id)).reduce((s, f) => s + f.annotations, 0), 0);
    const mergeCopies = requests.reduce((sum, request) => sum + request.group.files.filter(file => request.ids.includes(file.id) && file.annotations).length, 0);
    const skipped = groups.reduce((sum, group) => sum + group.files.filter(f => f.id !== keepers.get(group.id) && !requests.some(r => r.group.id === group.id && r.ids.includes(f.id))).length, 0);
    const answer = window.confirm(`确认处理 ${requests.length} 组、${count} 个副本？\n保留 ${requests.length} 份 PDF；本次不处理 ${skipped} 个副本。\n直接清理 ${count - mergeCopies} 个；先合并 ${mergeCopies} 个副本的 ${annotationCount} 条批注，再移入回收站。\n\n保留 / 副本编号可在窗口‘展开本次处理明细’核对。\n不永久删除、不清空回收站，不立即释放磁盘空间。请关闭相关 PDF 阅读器。操作会随 Zotero 同步。\n记录仅存本机，撤销请用‘操作记录 / 撤销’。`
      + (annotationCount ? "\n合并不删重批注、不改写旧附件链接；核验失败的整组不处理。不能仅从回收站恢复 PDF。" : "\n带批注或笔记的副本不会直接清理。"));
    if (!answer) { feedback("已取消，未修改附件。勾选已保留，可调整后重试。"); return; }
    busy = true; render(); let moved = 0, annotations = 0; const errors = [], warnings = [];
    try {
      await api.beginBatch();
      for (const [index, request] of requests.entries()) {
        if (closed) break;
        feedback(`正在处理第 ${index + 1}/${requests.length} 组，已移入回收站 ${moved} 个…`);
        try {
          const merge = request.group.files.some(file => request.ids.includes(file.id) && file.annotations > 0);
          if (merge) {
            const result = await api.merge(request.group.id, request.keeper, request.ids, "合并批注并清理");
            moved += result.moved; annotations += result.annotations;
            if (result.warning) warnings.push(result.warning);
          } else {
            const result = await api.trash(request.group.id, request.keeper, request.ids, "移入回收站");
            moved += result.moved;
            if (result.warning) warnings.push(result.warning);
          }
          groups = groups.filter(group => group.id !== request.group.id);
        } catch (error) { errors.push(`${request.group.title}：${error.message || error}`); }
      }
      feedback(`已迁移并核验 ${annotations} 条批注。已移入回收站 ${moved} 个副本；${errors.length} 组失败。未清空回收站。\n${errors.join("\n")}\n${warnings.join("\n")}${moved ? "\n已处理组已移出列表；如仅清理部分副本，可重新扫描。" : ""}`, errors.length > 0 || warnings.length > 0);
    } catch (error) { feedback(`处理未完成：${error.message || error}。已处理 ${moved} 个副本，请查看操作记录。`, true); }
    finally { busy = false; selected.clear(); render(); }
  }
  async function history() {
    if (busy) return;
    busy = true; render();
    try {
      const records = await api.history();
      $("history-list").hidden = false; $("history-list").replaceChildren();
      const batches = new Map();
      for (const record of records) {
        const id = record.batchID || record.id;
        if (!batches.has(id)) batches.set(id, []);
        batches.get(id).push(record);
      }
      for (const batch of batches.values()) {
        const pending = batch.filter(record => record.status !== "restored");
        const row = create("div", `${batch[0].createdAt} · ${batch.length} 组 · ${batch.reduce((n, r) => n + r.copies, 0)} 个副本 · ${pending.length ? "可核对撤销" : "已恢复"} `);
        const details = create("details"); details.append(create("summary", "展开操作明细"));
        for (const record of batch) details.append(create("div", `${record.title} · ${record.kind === "trash" ? "普通清理" : "批注合并"} · ${record.annotations} 条批注 / ${record.copies} 个副本 · ${record.status === "restored" ? "已恢复" : record.status === "committed" ? "已完成" : "待核对（可能未执行或已完成）"}`));
        row.append(details);
        if (pending.length) {
          const restore = button("撤销本次操作…", async () => {
            if (busy) return;
            const answer = window.confirm(`撤销本次剩余 ${pending.length} 组操作？\n恢复普通清理副本，并将已合并批注移回原附件。请关闭相关 PDF 阅读器。\n按组依次核对并恢复，遇到后续修改或缺失即停止；先前已恢复的组不会回滚。记录仅存本机，恢复会随 Zotero 同步。`);
            if (!answer) return;
            busy = true; render();
            let restored = 0; const messages = [];
            try {
              for (const record of pending) {
                feedback(`正在核对并撤销第 ${restored + 1}/${pending.length} 组…`);
                messages.push(await api.restore(record.id, "恢复操作")); restored++;
              }
              feedback(`本次 ${restored} 组已核对恢复。\n${messages.join("\n")}`);
            }
            catch (error) { feedback(`已核对恢复 ${restored} 组；剩余 ${pending.length - restored} 组停止：${error.message || error}\n${messages.join("\n")}`, true); }
            finally {
              groups = []; selected.clear(); keepers.clear(); busy = false;
              $("notes-panel").hidden = true; $("notes-panel").replaceChildren();
              $("history-list").replaceChildren(); $("history-list").hidden = true; render();
            }
          });
          restore.disabled = false; row.append(restore);
        }
        $("history-list").append(row);
      }
      if (!records.length) $("history-list").append(create("div", "本机当前资料库没有操作记录。旧版普通清理没有记录，仍需从 Zotero 回收站恢复。"));
    } catch (error) { feedback(String(error.message || error), true); }
    finally { busy = false; render(); }
  }
  window.addEventListener("load", () => {
    $("mode").value = "auto";
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
