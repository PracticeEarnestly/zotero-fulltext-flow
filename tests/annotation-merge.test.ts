import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import ts from "typescript";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

function setup() {
  const items = new Map<number, any>(), db = new Map<number, any>(), journals = new Map<string, any>();
  const pdfs = new Map<string, string>();
  const flags: any = { writes: 0, saves: 0, trash: 0, failWriteAt: 0, failSaveAt: 0, corruptReadback: false, failTrash: false };
  const readers: any[] = [];
  let transactionHook: any;
  const clone = (value: any) => JSON.parse(JSON.stringify(value));
  function make(id: number, type: string, parentID = 0) {
    let state: any = { id, key: `K${id}`, type, parentID, libraryID: 1, deleted: false,
      editable: true, stored: true, external: false, embedded: false, note: "", attachmentPath: `storage:${id}.pdf`,
      data: { annotationType: "highlight", annotationText: "identical text", annotationComment: `comment-${id}`,
        annotationColor: "#ffd400", annotationPosition: '{"pageIndex":0,"rects":[[1,2,3,4]]}',
        annotationSortIndex: "00000|000001|00000", tags: [{ tag: "important" }], relations: {}, dateAdded: "2026-10-25T00:00:00Z" } };
    db.set(id, clone(state));
    const item: any = {
      isRegularItem: () => type === "regular", isAnnotation: () => type === "annotation",
      isPDFAttachment: () => type === "pdf", isStoredFileAttachment: () => state.stored,
      isEditable: () => state.editable, getField: () => `Title ${id}`,
      getNotes: () => [], getNote: () => state.note,
      getAttachments: () => [...items.values()].filter(i => i.parentID === id && i.isPDFAttachment()).map(i => i.id),
      getAnnotations: () => [...items.values()].filter(i => i.parentID === id && i.isAnnotation()),
      hasEmbeddedAnnotations: async () => { if (flags.embeddedError) throw new Error("PDF parse failed"); return state.embedded; },
      getFilePathAsync: async () => `/pdf/${id}.pdf`,
      toJSON: () => ({ key: state.key, itemType: type, parentItem: items.get(state.parentID)?.key, version: 1, dateModified: "now", ...clone(state.data) }),
      loadAllData: async (reload = false) => { if (reload) { state = clone(db.get(id)); if (flags.corruptReadback && type === "annotation" && id === 21) state.data.annotationComment = "CORRUPTED"; } },
      save: async () => {
        flags.saves++; if (flags.saves === flags.failSaveAt) throw new Error("save failed");
        db.set(id, clone(state));
      },
      change: (key: string, value: any) => { state.data[key] = value; db.set(id, clone(state)); },
      persist: () => db.set(id, clone(state))
    };
    for (const key of ["id", "key", "libraryID", "parentID", "deleted", "editable", "stored", "embedded", "note", "attachmentPath"]) {
      Object.defineProperty(item, key, { get: () => state[key], set: value => { state[key] = value; } });
    }
    Object.defineProperty(item, "parentItemID", { get: () => state.parentID, set: value => { state.parentID = value; } });
    Object.defineProperty(item, "annotationIsExternal", { get: () => state.external, set: value => { state.external = value; } });
    items.set(id, item);
    if (type === "pdf") pdfs.set(`/pdf/${id}.pdf`, "%PDF-byte-identical");
    return item;
  }
  const p = make(1, "regular"), keeper = make(11, "pdf", 1), source = make(12, "pdf", 1);
  const original = make(20, "annotation", 11), a = make(21, "annotation", 12), b = make(22, "annotation", 12);
  // Keep content-identical annotations as separate original records (no automatic deduplication).
  b.change("annotationComment", "comment-21");
  const sandbox: any = {
    Services: { uuid: { generateUUID: () => "{12345678-1234-1234-1234-123456789abc}" } },
    Zotero: { DataDirectory: { dir: "/zotero" }, Reader: { _readers: readers }, Promise: { delay: async () => {} },
      Libraries: { get: () => ({ hasTrash: true }) },
      Items: { getAsync: async (ids: any) => Array.isArray(ids) ? ids.map(id => items.get(id)) : items.get(ids),
        trash: async (ids: number[]) => { flags.trash++; for (const id of ids) { const item = items.get(id); item.deleted = true; await item.save(); } if (flags.failTrash) throw new Error("trash failed"); } },
      DB: { executeTransaction: async (fn: any) => {
        const before = new Map([...db].map(([id, state]) => [id, clone(state)]));
        try { await transactionHook?.(); return await fn(); }
        catch (error) { db.clear(); for (const [id, state] of before) db.set(id, state); throw error; }
      } }
    },
    IOUtils: {
      exists: async (path: string) => path === "/zotero/fulltextflow-annotation-merges" ? journals.size > 0 : pdfs.has(path),
      makeDirectory: async () => {},
      writeJSON: async (path: string, value: any) => { flags.writes++; if (flags.writes === flags.failWriteAt) throw new Error("disk full"); journals.set(path, clone(value)); },
      readJSON: async (path: string) => { if (!journals.has(path)) throw new Error("missing journal"); return clone(journals.get(path)); },
      getChildren: async () => [...journals.keys()],
      stat: async (path: string) => { if (!pdfs.has(path)) throw new Error("missing PDF"); return { type: "regular", size: pdfs.get(path)!.length, lastModified: 1 }; },
      read: async (path: string) => Uint8Array.from(Buffer.from(pdfs.get(path)!.slice(0, 5)))
    },
    AttachmentGuard: { withItemLock: async (_: any, fn: any) => fn(),
      sha256: async (path: string) => { if (!pdfs.has(path)) throw new Error("missing PDF"); return createHash("sha256").update(pdfs.get(path)!).digest("hex"); } }
  };
  const code = ["AnnotationMerge", "DuplicateAttachments"].map(name => readFileSync(new URL(`../src/core/${name}.ts`, import.meta.url), "utf8")
    .replace(/^import .*$/gm, "").replace(/^export /gm, "")).join("\n");
  vm.runInNewContext(ts.transpileModule(code + "\nglobalThis.Merge = AnnotationMerge; globalThis.Scanner = DuplicateAttachments;", {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }
  }).outputText, sandbox);
  const scanner = new sandbox.Scanner();
  return { ...sandbox, scanner, flags, items, db, journals, pdfs, p, keeper, source, original, a, b, readers,
    hook: (hook: any) => { transactionHook = hook; },
    run: async () => { const { groups } = await scanner.scan([p]); return scanner.trash(groups[0].id, 11, [12], "合并批注并清理", true); },
    restore: async () => scanner.restore("12345678-1234-1234-1234-123456789abc", 1, "恢复合并") };
}

test("merge preserves keys, comments, tags, positions and both identical annotations; restore returns originals", async () => {
  const e = setup(); const contents = [e.a, e.b, e.original].map(item => e.Merge.content(item));
  const result = await e.run(); assert.equal(result.annotations, 2); assert.equal(result.moved, 1);
  assert.equal(e.source.deleted, true); assert.equal(e.keeper.deleted, false);
  assert.equal(e.keeper.getAnnotations().length, 3);
  assert.deepEqual([e.a, e.b, e.original].map(item => e.Merge.content(item)), contents);
  assert.equal((await e.scanner.history(1))[0].status, "committed");
  assert.match(await e.restore(), /已恢复 1 个附件/);
  assert.equal(e.a.parentID, 12); assert.equal(e.b.parentID, 12); assert.equal(e.original.parentID, 11);
  assert.equal(e.source.deleted, false); assert.equal((await e.scanner.history(1))[0].status, "restored");
  assert.match(await e.restore(), /已处于合并前状态/); assert.equal(e.pdfs.size, 2);
});

test("write-ahead journal failure prevents any database writes", async () => {
  const e = setup(); e.flags.failWriteAt = 1;
  await assert.rejects(e.run(), /disk full/); assert.equal(e.flags.saves, 0); assert.equal(e.flags.trash, 0);
});

for (const failure of ["save", "readback", "trash"]) {
  test(`failure during ${failure} rolls back annotation ownership and source trash`, async () => {
    const e = setup();
    if (failure === "save") e.flags.failSaveAt = 2;
    if (failure === "readback") e.flags.corruptReadback = true;
    if (failure === "trash") e.flags.failTrash = true;
    await assert.rejects(e.run());
    assert.equal(e.db.get(21).parentID, 12); assert.equal(e.db.get(22).parentID, 12);
    assert.equal(e.db.get(12).deleted, false); assert.equal(e.a.parentID, 12);
    assert.equal((await e.scanner.history(1))[0].status, "prepared");
  });
}

test("post-commit journal failure reports success with warning and pending journal can recover after restart", async () => {
  const e = setup(); e.flags.failWriteAt = 2;
  const result = await e.run(); assert.match(result.warning, /已完成/);
  assert.equal(e.a.parentID, 11); assert.equal(e.source.deleted, true);
  const restarted = new e.Scanner();
  assert.equal((await restarted.history(1))[0].status, "prepared");
  await restarted.restore(result.recordID, 1, "恢复合并"); assert.equal(e.a.parentID, 12);
});

for (const [label, change] of [
  ["open reader", (e: any) => e.readers.push({ itemID: 12 })],
  ["external annotation", (e: any) => { e.a.annotationIsExternal = true; }],
  ["embedded PDF annotations", (e: any) => { e.source.embedded = true; }],
  ["PDF annotation parser failure", (e: any) => { e.flags.embeddedError = true; }],
  ["attachment note", (e: any) => { e.source.note = "note"; }],
  ["uneditable annotation", (e: any) => { e.a.editable = false; }],
  ["trashed annotation", (e: any) => { e.a.deleted = true; }]
] as [string, (e: any) => void][]) {
  test(`merge blocks ${label}`, async () => {
    const e = setup(); change(e); await assert.rejects(e.run());
    assert.equal(e.flags.saves, 0); assert.equal(e.flags.trash, 0);
  });
}

test("changed annotation count after scan is rejected before journaling", async () => {
  const e = setup(); const { groups } = await e.scanner.scan([e.p]);
  e.items.delete(22);
  await assert.rejects(e.scanner.trash(groups[0].id, 11, [12], "合并批注并清理", true), /数量/);
  assert.equal(e.flags.writes, 0);
});

test("late annotation changes before transaction are rejected without trash", async () => {
  const e = setup(); e.hook(() => e.a.change("annotationComment", "new comment"));
  await assert.rejects(e.run(), /已变化/); assert.equal(e.flags.trash, 0);
});

for (const [label, change] of [
  ["edited moved annotation", (e: any) => e.a.change("annotationComment", "new work")],
  ["permanently removed source", (e: any) => e.items.delete(12)],
  ["changed PDF", (e: any) => e.pdfs.set("/pdf/12.pdf", "%PDF-changed")],
  ["moved annotation again", (e: any) => { e.a.parentItemID = 99; e.a.persist(); }],
  ["manual restore of PDF only", (e: any) => { e.source.deleted = false; e.source.persist(); }],
  ["open keeper reader", (e: any) => e.readers.push({ itemID: 11 })],
  ["deleted keeper", (e: any) => { e.keeper.deleted = true; e.keeper.persist(); }]
] as [string, (e: any) => void][]) {
  test(`restore refuses ${label} without writing`, async () => {
    const e = setup(); await e.run(); change(e); const before = e.flags.saves;
    await assert.rejects(e.restore()); assert.equal(e.flags.saves, before);
  });
}

test("restore failure midway rolls back to merged state", async () => {
  const e = setup(); await e.run(); e.flags.failSaveAt = e.flags.saves + 3;
  await assert.rejects(e.restore(), /save failed/);
  assert.equal(e.a.parentID, 11); assert.equal(e.b.parentID, 11); assert.equal(e.source.deleted, true);
});

test("restore preserves unrelated keeper edits and added content", async () => {
  const e = setup(); await e.run(); e.original.change("annotationComment", "new keeper comment");
  await e.restore(); assert.equal(e.original.toJSON().annotationComment, "new keeper comment");
});

test("restore requires exact confirmation and matching library", async () => {
  const e = setup(); const result = await e.run(); const before = e.flags.saves;
  await assert.rejects(e.scanner.restore(result.recordID, 1, ""));
  await assert.rejects(e.scanner.restore(result.recordID, 2, "恢复合并"));
  assert.equal(e.flags.saves, before);
});

test("restore detects file-path changes at transaction entry", async () => {
  const e = setup(); await e.run(); const before = e.flags.saves;
  e.hook(() => { e.source.attachmentPath = "storage:other.pdf"; });
  await assert.rejects(e.restore(), /附件状态/); assert.equal(e.flags.saves, before);
});

test("failed merge's prepared journal can be safely reconciled without moving anything", async () => {
  const e = setup(); e.flags.failSaveAt = 2; await assert.rejects(e.run());
  const before = e.flags.saves; assert.match(await e.restore(), /已处于合并前状态/);
  assert.equal(e.flags.saves, before);
});

test("restore record write failure is idempotently recoverable", async () => {
  const e = setup(); await e.run(); e.flags.failWriteAt = 3;
  assert.match(await e.restore(), /已恢复；记录标记写入失败/);
  const before = e.flags.saves; assert.match(await e.restore(), /已处于合并前状态/);
  assert.equal(e.flags.saves, before);
});

test("missing reader inventory fails closed", async () => {
  const e = setup(); delete e.Zotero.Reader._readers;
  await assert.rejects(e.run(), /阅读器状态/); assert.equal(e.flags.saves, 0);
});

test("closing window while awaiting transaction rolls back merge", async () => {
  const e = setup(); e.hook(() => e.scanner.cancel());
  await assert.rejects(e.run(), /关闭|取消/); assert.equal(e.source.deleted, false); assert.equal(e.a.parentID, 12);
});
