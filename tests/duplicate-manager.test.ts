import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import vm from "node:vm";
import ts from "typescript";

function setup() {
  const items = new Map<number, any>(), files = new Map<string, any>(), trashed: number[][] = [];
  let hashHook: any, transactionHook: any, hashes = 0;
  const parent = (id: number, libraryID = 1) => {
    const value = { id, key: `P${id}`, libraryID, deleted: false, editable: true,
      isRegularItem: () => true, isEditable() { return this.editable; },
      getField: () => `Parent ${id}`, loadAllData: async () => {},
      getAttachments: () => [...items.values()].filter(i => i.parentID === id).map(i => i.id) };
    items.set(id, value); return value;
  };
  const add = (id: number, p: any, content = "%PDF-identical", extra: any = {}) => {
    const path = `/storage/${id}.pdf`;
    files.set(path, { content, size: content.length, lastModified: 1, type: "regular" });
    const value = { id, key: `F${id}`, libraryID: p.libraryID, parentID: p.id, path, attachmentPath: `storage:${id}.pdf`, deleted: false,
      annotations: [], notes: [], note: "", editable: true, stored: true, pdf: true,
      isPDFAttachment() { return this.pdf; }, isStoredFileAttachment() { return this.stored; },
      isEditable() { return this.editable; }, loadAllData: async () => {},
      toJSON() { return { key: this.key, title: `File ${id}`, deleted: this.deleted }; },
      getAnnotations() { return this.annotations; }, getNotes() { return this.notes; }, getNote() { return this.note; },
      getFilePathAsync() { return this.path; }, getField: () => `<script>File ${id}</script>`, ...extra };
    items.set(id, value); return value;
  };
  const sandbox: any = {
    Services: { uuid: { generateUUID: () => "{12345678-1234-1234-1234-123456789abc}" } },
    Zotero: {
      DataDirectory: { dir: "/test" }, Reader: { _readers: [] },
      Promise: { delay: async () => {} }, Libraries: { get: () => ({ hasTrash: true }) },
      Items: { getAsync: async (ids: number | number[]) => Array.isArray(ids) ? ids.map(id => items.get(id)) : items.get(ids),
        trash: async (ids: number[]) => { trashed.push(Array.from(ids)); for (const id of ids) items.get(id).deleted = true; } },
      DB: { executeTransaction: async (fn: any) => { await transactionHook?.(); return fn(); } }
    },
    IOUtils: {
      makeDirectory: async () => {}, writeJSON: async () => {},
      stat: async (path: string) => { if (!files.has(path)) throw new Error("Missing file"); return { ...files.get(path) }; },
      read: async (path: string) => Uint8Array.from(Buffer.from(files.get(path).content.slice(0, 5)))
    },
    AttachmentGuard: { withItemLock: async (_parent: any, fn: any) => fn(),
      sha256: async (path: string) => { hashes++; const hash = createHash("sha256").update(files.get(path).content).digest("hex"); await hashHook?.(path); return hash; } }
  };
  const source = ["AnnotationMerge", "DuplicateAttachments"].map(name => readFileSync(new URL(`../src/core/${name}.ts`, import.meta.url), "utf8")
    .replace(/^import .*$/gm, "").replace(/^export /gm, "")).join("\n");
  vm.runInNewContext(ts.transpileModule(source + "\nglobalThis.Scanner = DuplicateAttachments;", {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }
  }).outputText, sandbox);
  const scanner = new sandbox.Scanner();
  const p = parent(1); const a = add(11, p), b = add(12, p);
  return { scanner, parent, add, p, a, b, items, files, trashed, sandbox,
    hashHook: (hook: any) => { hashHook = hook; }, transactionHook: (hook: any) => { transactionHook = hook; },
    hashCount: () => hashes,
    scan: () => scanner.scan([p]),
    trash: (group: any, keeper = 11, ids = [12], confirmation = "移入回收站") => scanner.trash(group.id, keeper, ids, confirmation) };
}

test("scan groups only same-parent equal content and hashes only equal sizes", async () => {
  const e = setup(); const p2 = e.parent(2), p3 = e.parent(3, 2);
  e.add(21, p2); e.add(31, p3); e.add(13, e.p, "%PDF-different"); e.add(14, e.p, "%PDF-longer content");
  const result = await e.scanner.scan([e.p, p2, p3, e.p]);
  assert.equal(result.checked, 3); assert.equal(result.groups.length, 1);
  assert.deepEqual(Array.from(result.groups[0].files, (f: any) => f.id), [11, 12]);
  assert.equal(e.hashCount(), 3); assert.equal(e.trashed.length, 0);
});

test("trash only requested IDs; preserve parent, keeper and physical files", async () => {
  const e = setup(); const { groups } = await e.scan();
  assert.equal((await e.trash(groups[0])).moved, 1);
  assert.deepEqual(e.trashed, [[12]]); assert.equal(e.a.deleted, false); assert.equal(e.p.deleted, false);
  assert.equal(e.files.size, 2);
  await assert.rejects(e.trash(groups[0])); // Consumed snapshot cannot be replayed
});

test("refuse missing confirmation, arbitrary IDs, or deleting the keeper", async () => {
  const e = setup(); const { groups } = await e.scan();
  for (const args of [[11, [12], ""], [11, [11, 12], "移入回收站"], [999, [12], "移入回收站"], [11, [999], "移入回收站"]] as any[]) {
    await assert.rejects(e.trash(groups[0], ...args));
  }
  assert.equal(e.trashed.length, 0);
});

for (const [name, mutate] of [
  ["new annotations", (e: any) => { e.b.annotations.push(42); }],
  ["child notes", (e: any) => { e.b.notes.push(42); }],
  ["embedded Zotero note", (e: any) => { e.b.note = "important"; }],
  ["read-only attachment", (e: any) => { e.b.editable = false; }],
  ["linked file", (e: any) => { e.b.stored = false; }],
  ["reparented attachment", (e: any) => { e.b.parentID = 2; }],
  ["changed library", (e: any) => { e.b.libraryID = 2; }],
  ["deleted keeper", (e: any) => { e.a.deleted = true; }],
  ["deleted parent", (e: any) => { e.p.deleted = true; }],
  ["read-only parent", (e: any) => { e.p.editable = false; }],
  ["changed hash with same stat", (e: any) => { e.files.get(e.b.path).content = "%PDF-changed!!"; }],
  ["changed modified time", (e: any) => { e.files.get(e.b.path).lastModified++; }],
  ["missing keeper file", (e: any) => { e.files.delete(e.a.path); }]
] as [string, (e: any) => void][]) {
  test(`revalidation rejects ${name}`, async () => {
    const e = setup(); const { groups } = await e.scan(); mutate(e);
    await assert.rejects(e.trash(groups[0])); assert.equal(e.trashed.length, 0);
  });
}

test("annotated keeper is retained while clean duplicate can be trashed", async () => {
  const e = setup(); e.a.annotations.push(7); const { groups } = await e.scan();
  assert.match(groups[0].files[0].protectedReason, /批注/);
  await e.trash(groups[0]); assert.equal(e.a.deleted, false);
});

test("UI mutations cannot bypass trusted snapshots", async () => {
  const e = setup(); const { groups } = await e.scan();
  groups[0].files[1].hash = "tampered"; e.files.get(e.b.path).content = "%PDF-new!!!!!!";
  await assert.rejects(e.trash(groups[0])); assert.equal(e.trashed.length, 0);
});

test("metadata changes at transaction entry abort before trash", async () => {
  const e = setup(); const { groups } = await e.scan();
  e.transactionHook(() => e.b.annotations.push(1));
  await assert.rejects(e.trash(groups[0])); assert.equal(e.trashed.length, 0);
});

test("keeper changing while another file is hashed aborts the group", async () => {
  const e = setup(); const { groups } = await e.scan();
  e.hashHook((path: string) => { if (path === e.b.path) e.files.get(e.a.path).lastModified++; });
  await assert.rejects(e.trash(groups[0])); assert.equal(e.trashed.length, 0);
});

test("path changes at transaction entry are rejected", async () => {
  const e = setup(); const { groups } = await e.scan();
  e.transactionHook(() => { e.b.attachmentPath = "storage:another.pdf"; });
  await assert.rejects(e.trash(groups[0])); assert.equal(e.trashed.length, 0);
});

test("closing the window during revalidation prevents pending trash", async () => {
  const e = setup(); const { groups } = await e.scan();
  e.hashHook(() => e.scanner.cancel());
  await assert.rejects(e.trash(groups[0]), /已关闭|取消/); assert.equal(e.trashed.length, 0);
});

test("missing and invalid PDFs are reported, never returned as deletable groups", async () => {
  const e = setup(); e.files.get(e.b.path).content = "BAD!-identical";
  let result = await e.scan(); assert.equal(result.groups.length, 0); assert.equal(result.skipped.length, 1);
  e.files.delete(e.b.path); result = await e.scan(); assert.equal(result.skipped.length, 1);
});

test("shared file paths are protected", async () => {
  const e = setup(); e.b.path = e.a.path; const { groups } = await e.scan();
  assert.match(groups[0].files[1].protectedReason, /同一路径/);
  await assert.rejects(e.trash(groups[0])); assert.equal(e.trashed.length, 0);
});

test("cancelled scan invalidates prior groups and changes nothing", async () => {
  const e = setup(); const { groups } = await e.scan();
  await assert.rejects(e.scanner.scan([e.p], () => e.scanner.cancel()), /取消/);
  await assert.rejects(e.trash(groups[0])); assert.equal(e.trashed.length, 0);
});

test("cancellation during scope loading is preserved and concurrent scans rejected", async () => {
  const e = setup(); let ready: any;
  const run = e.scanner.scan(() => new Promise(resolve => { ready = resolve; }));
  e.scanner.cancel(); await assert.rejects(e.scan(), /正在进行/);
  ready([e.p]); await assert.rejects(run, /取消/); assert.equal(e.trashed.length, 0);
});

test("note inspection is read-only, scoped to scanned attachments and includes trashed child notes", async () => {
  const e = setup(); e.a.note = '<p>A</p><img src="https://invalid.test/image" onerror="bad()">';
  e.b.notes = [40];
  e.items.set(40, { id: 40, key: "N40", parentID: 12, libraryID: 1, deleted: true,
    isNote: () => true, loadAllData: async () => {}, getNote: () => "<p>B</p>" });
  const { groups } = await e.scan(); const result = await e.scanner.notes(groups[0].id);
  assert.equal(result[0].notes[0].html, e.a.note); assert.equal(result[1].notes[0].deleted, true);
  assert.equal(e.trashed.length, 0);
  await assert.rejects(e.scanner.notes("arbitrary"));
  e.items.get(40).parentID = 99;
  await assert.rejects(e.scanner.notes(groups[0].id), /归属/);
});

test("note inspection rejects moved attachment and canceled scans", async () => {
  const e = setup(); const { groups } = await e.scan();
  e.b.parentID = 2; await assert.rejects(e.scanner.notes(groups[0].id), /已变化/);
  e.b.parentID = 1; e.scanner.cancel(); await assert.rejects(e.scanner.notes(groups[0].id), /完成扫描/);
});

class Element {
  children: Element[] = []; events = new Map<string, Function>(); attributes: any = {}; dataset: any = {};
  textContent = ""; value = ""; checked = false; disabled = false; type = "";
  append(...nodes: Element[]) { this.children.push(...nodes); }
  replaceChildren() { this.children = []; }
  setAttribute(key: string, value: string) { this.attributes[key] = value; }
  addEventListener(event: string, fn: Function) { this.events.set(event, fn); }
  async fire(event: string) { await this.events.get(event)?.(); }
}
async function uiSetup() {
  const xml = readFileSync(new URL("../addon/content/duplicate-manager.xhtml", import.meta.url), "utf8");
  const elements = new Map([...xml.matchAll(/\bid="([^"]+)"/g)].map(match => [match[1], new Element()]));
  const get = (id: string) => elements.get(id)!;
  const files = [11, 12, 13].map(id => ({ id, key: `F${id}`, title: "<script>bad()</script>", hash: "abcd", size: 1000,
    path: `/${id}.pdf`, annotations: id === 13 ? 1 : 0, notes: 0, protectedReason: id === 13 ? "有批注" : "" }));
  const calls: any[] = [], listeners = new Map<string, Function>();
  const api: any = { scopeLabel: "Test library", selectedCount: 1,
    beginBatch: () => {},
    scan: async () => ({ groups: [{ id: "group", title: "<script>bad()</script>", parentID: 1, files }], skipped: [], checked: 1 }),
    trash: async (...args: any[]) => { calls.push(args); return { moved: args[2].length, warning: "" }; },
    cancel: () => {}, open: async (id: number) => calls.push(["open", id]), locate: async () => {} };
  const window: any = { arguments: [{ wrappedJSObject: api }], prompt: () => null, confirm: () => false,
    addEventListener: (event: string, fn: Function) => listeners.set(event, fn) };
  vm.runInNewContext(readFileSync(new URL("../addon/content/duplicate-manager.js", import.meta.url), "utf8"), {
    window, document: { getElementById: get, createElementNS: () => new Element() }
  });
  await listeners.get("load")!(); await get("scan").fire("click");
  const all = (node: Element): Element[] => [node, ...node.children.flatMap(all)];
  return { get, calls, window, api, files, all, controls: () => all(get("groups")).filter(n => n.type === "radio" || n.type === "checkbox") };
}

test("UI starts with no cleanup selection and automatically preserves annotated copy", async () => {
  const e = await uiSetup(); assert.equal(e.get("trash").disabled, true);
  const controls = e.controls();
  assert.equal(controls.filter(n => n.type === "checkbox" && n.checked).length, 0);
  assert.equal(controls.find(n => n.attributes["aria-label"] === "保留 F13")?.checked, true);
  await e.get("choose").fire("click"); await e.get("trash").fire("click");
  assert.equal(e.calls.length, 0); // Canceling confirmation never writes
});

test("UI clears group selection when keeper changes; protected attachments stay disabled", async () => {
  const e = await uiSetup(); e.get("mode").value = "trash"; await e.get("mode").fire("change");
  await e.get("choose").fire("click");
  await e.controls().find(n => n.attributes["aria-label"] === "保留 F11")!.fire("change");
  assert.equal(e.get("trash").disabled, true);
  assert.equal(e.controls().find(n => n.attributes["aria-label"] === "清理 F13")!.disabled, true);
  await e.get("choose").fire("click"); e.window.confirm = () => true;
  await e.get("trash").fire("click");
  assert.deepEqual(JSON.parse(JSON.stringify(e.calls)), [["group", 11, [12], "移入回收站"]]);
  assert.match(e.get("feedback").textContent, /已移入回收站 1 个/);
});

test("UI reports backend failures without claiming success or retaining destructive selection", async () => {
  const e = await uiSetup(); e.api.trash = async () => { throw new Error("附件新增批注"); };
  await e.get("choose").fire("click"); e.window.confirm = () => true;
  await e.get("trash").fire("click");
  assert.match(e.get("feedback").textContent, /已移入回收站 0 个副本；1 组失败/);
  assert.match(e.get("feedback").textContent, /新增批注/); assert.equal(e.get("trash").disabled, true);
});

test("merge-only mode clears old selections and requires explicit summary confirmation", async () => {
  const e = await uiSetup();
  e.api.merge = async (...args: any[]) => { e.calls.push(["merge", ...args]); return { moved: 1, annotations: 1 }; };
  await e.controls().find(n => n.attributes["aria-label"] === "保留 F11")!.fire("change");
  await e.get("choose").fire("click");
  e.get("mode").value = "merge"; await e.get("mode").fire("change");
  assert.equal(e.get("trash").disabled, true);
  await e.get("choose").fire("click");
  assert.equal(e.controls().find(n => n.attributes["aria-label"] === "清理 F13")!.checked, true);
  assert.equal(e.controls().find(n => n.attributes["aria-label"] === "清理 F12")!.checked, false);
  await e.get("trash").fire("click"); assert.equal(e.calls.length, 0);
  assert.match(e.get("feedback").textContent, /已取消，未修改/);
  e.window.confirm = (message: string) => { assert.match(message, /1 条批注/); assert.match(e.get("selected-preview").textContent, /保留：F11/); return true; };
  await e.get("trash").fire("click");
  assert.deepEqual(JSON.parse(JSON.stringify(e.calls)), [["merge", "group", 11, [13], "合并批注并清理"]]);
  assert.match(e.get("feedback").textContent, /已迁移并核验 1 条批注/);
});

test("merge mode protects notes and uneditable keeper", async () => {
  const e = await uiSetup();
  await e.controls().find(n => n.attributes["aria-label"] === "保留 F11")!.fire("change");
  (e.files[0] as any).mergeReason = "附件带笔记";
  e.get("mode").value = "merge"; await e.get("mode").fire("change"); await e.get("choose").fire("click");
  assert.equal(e.get("trash").disabled, true);
});

test("smart mode selects clean and annotated copies together and merges the group atomically", async () => {
  const e = await uiSetup();
  assert.equal(e.get("mode").value, "auto");
  await e.controls().find(n => n.attributes["aria-label"] === "保留 F11")!.fire("change");
  await e.get("choose").fire("click");
  assert.match(e.get("selection").textContent, /已选 2 个副本 · 直接清理 1 个 · 先合并 1 个 \/ 1 条批注/);
  assert.match(e.get("trash").textContent, /合并批注并移入回收站/);
  e.api.merge = async (...args: any[]) => { e.calls.push(["merge", ...args]); return { moved: 2, annotations: 1 }; };
  e.window.confirm = (message: string) => {
    assert.match(message, /直接清理 1 个；先合并 1 个副本的 1 条批注/);
    assert.match(e.get("selected-preview").textContent, /副本：F12、F13/); return true;
  };
  await e.get("trash").fire("click");
  assert.deepEqual(JSON.parse(JSON.stringify(e.calls)), [["merge", "group", 11, [12, 13], "合并批注并清理"]]);
  assert.match(e.get("feedback").textContent, /已迁移并核验 1 条批注。已移入回收站 2 个副本；0 组失败/);
});

test("smart mode routes mixed groups independently and never falls back to trash after a merge failure", async () => {
  const e = await uiSetup();
  const files = (base: number, annotated: boolean) => [0, 1].map(i => ({ ...e.files[0], id: base + i,
    key: `F${base + i}`, annotations: annotated ? 1 : 0, protectedReason: annotated ? "有批注" : "", mergeReason: "" }));
  e.api.scan = async () => ({ checked: 2, skipped: [], groups: [
    { id: "clean", parentID: 1, title: "Clean", files: files(20, false) },
    { id: "annotated", parentID: 2, title: "Annotated", files: files(30, true) }
  ] });
  await e.get("scan").fire("click"); await e.get("choose").fire("click");
  e.api.merge = async (...args: any[]) => { e.calls.push(["merge", ...args]); throw new Error("PDF 内嵌批注"); };
  e.window.confirm = () => true;
  await e.get("trash").fire("click");
  assert.deepEqual(JSON.parse(JSON.stringify(e.calls)), [
    ["clean", 20, [21], "移入回收站"], ["merge", "annotated", 30, [31], "合并批注并清理"]
  ]);
  assert.match(e.get("feedback").textContent, /已移入回收站 1 个副本；1 组失败/);
  assert.match(e.get("feedback").textContent, /PDF 内嵌批注/);
  assert.equal(e.get("trash").disabled, true);
});

test("smart mode explains protected copies and allows clean copies when the keeper has notes", async () => {
  const e = await uiSetup();
  Object.assign(e.files[2], { notes: 1, mergeReason: "附件带笔记" });
  await e.get("scan").fire("click"); await e.get("choose").fire("click");
  assert.match(e.get("selection").textContent, /直接清理 2 个 · 先合并 0 个/);
  await e.controls().find(n => n.attributes["aria-label"] === "保留 F11")!.fire("change");
  await e.get("choose").fire("click");
  assert.equal(e.controls().find(n => n.attributes["aria-label"] === "清理 F13")!.disabled, true);
  assert.match(e.get("summary").textContent, /可选 1 个副本 · 暂不处理 1 个副本/);
  assert.ok(e.all(e.get("groups")).some(n => n.textContent === "附件带笔记"));
});

test("one-click selection does not mutate anything and unavailable selection explains the next step", async () => {
  const e = await uiSetup();
  for (const f of e.files) Object.assign(f, { protectedReason: "附件带笔记", mergeReason: "附件带笔记", notes: 1 });
  await e.get("scan").fire("click");
  assert.equal(e.get("choose").disabled, true);
  assert.match(e.get("next-step").textContent, /没有可安全处理/);
  await e.get("choose").fire("click"); await e.get("trash").fire("click");
  assert.equal(e.calls.length, 0);
});

test("busy execution cannot submit twice", async () => {
  const e = await uiSetup(); let complete: any;
  e.api.trash = async (...args: any[]) => { e.calls.push(args); return new Promise(resolve => { complete = resolve; }); };
  await e.get("choose").fire("click"); e.window.confirm = () => true;
  const run = e.get("trash").fire("click");
  assert.equal(e.get("trash").disabled, true); assert.equal(e.get("choose").disabled, true);
  await e.get("trash").fire("click"); assert.equal(e.calls.length, 1);
  complete({ moved: 2 }); await run;
});

test("history restore requires confirmation, reports errors and clears stale scan results", async () => {
  const e = await uiSetup();
  e.api.history = async () => [{ id: "R1", title: "Paper", annotations: 1, copies: 1, status: "prepared", createdAt: "now" }];
  e.api.restore = async (...args: any[]) => { e.calls.push(args); throw new Error("批注已被修改"); };
  await e.get("history").fire("click");
  const restore = e.all(e.get("history-list")).find(n => n.textContent === "撤销本次操作…")!;
  assert.equal(restore.disabled, false);
  await restore.fire("click"); assert.equal(e.calls.length, 0);
  e.window.confirm = () => true; await restore.fire("click");
  assert.deepEqual(JSON.parse(JSON.stringify(e.calls)), [["R1", "恢复操作"]]);
  assert.match(e.get("feedback").textContent, /被修改/); assert.equal(e.controls().length, 0);
});

test("UI groups actionable and manual results and shows notes as inert text", async () => {
  const e = await uiSetup();
  for (const f of e.files) Object.assign(f, { notes: 1, protectedReason: "附件带笔记", mergeReason: "附件带笔记" });
  await e.get("scan").fire("click");
  assert.ok(e.all(e.get("groups")).some(n => n.textContent === "需人工处理（1 组）"));
  const payload = '<img src="https://invalid.test/image" onerror="bad()">';
  e.api.notes = async () => e.files.map(f => ({ key: f.key, notes: [{ key: f.key, deleted: false, html: f.id === 11 ? payload : "<p>Different</p>" }] }));
  await e.all(e.get("groups")).find(n => n.textContent === "查看笔记差异（只读）")!.fire("click");
  assert.ok(e.all(e.get("notes-panel")).some(n => n.textContent.includes(payload)));
  assert.ok(e.all(e.get("notes-panel")).some(n => n.textContent === "笔记原文不同，请人工核对"));
  assert.equal(e.calls.length, 0); assert.equal(e.get("choose").disabled, true);
});

test("batch undo unifies direct and merged records and stops after a conflict", async () => {
  const e = await uiSetup();
  e.api.history = async () => ["a", "b", "c"].map((id, i) => ({ id, batchID: "BATCH", kind: i ? "merge" : "trash", title: id,
    annotations: i ? 2 : 0, copies: 1, status: "committed", createdAt: "now" }));
  e.api.restore = async (id: string) => { e.calls.push(id); if (id === "b") throw new Error("后续修改"); return "已恢复"; };
  await e.get("history").fire("click");
  const buttons = e.all(e.get("history-list")).filter(n => n.textContent === "撤销本次操作…");
  assert.equal(buttons.length, 1);
  await buttons[0].fire("click"); assert.equal(e.calls.length, 0);
  e.window.confirm = () => true; await buttons[0].fire("click");
  assert.deepEqual(e.calls, ["a", "b"]);
  assert.match(e.get("feedback").textContent, /已核对恢复 1 组；剩余 2 组停止/);
});

test("ordinary cleanup shows journal warnings without misreporting committed copies", async () => {
  const e = await uiSetup(); e.api.trash = async () => ({ moved: 2, warning: "完成标记写入失败" });
  await e.get("choose").fire("click"); e.window.confirm = () => true;
  await e.get("trash").fire("click");
  assert.match(e.get("feedback").textContent, /已移入回收站 2 个副本/);
  assert.match(e.get("feedback").textContent, /完成标记写入失败/);
  assert.equal(e.get("feedback").dataset.error, "true");
});
