import { AttachmentGuard } from "./AttachmentGuard";
import type { DuplicateFile } from "./DuplicateAttachments";

type MergeAnnotation = { id: number; key: string; fromID: number; content: string };
type MergeRecord = {
  schema: 1; id: string; createdAt: string; status: "prepared" | "committed" | "restored";
  libraryID: number; parentID: number; title: string; keeperID: number;
  files: DuplicateFile[]; annotations: MergeAnnotation[]; keeperAnnotations: MergeAnnotation[];
  kind?: "merge" | "trash"; batchID?: string;
  sourceContents?: Record<string, string>;
};

// Write-ahead journal is local to the Zotero data directory, NOT synced by Zotero.
// A prepared journal survives a crash between DB commit and final journal update.
export class AnnotationMerge {
  private static get directory() { return `${Zotero.DataDirectory.dir}/fulltextflow-annotation-merges`; }
  private static path(id: string) {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("无效的合并记录编号。");
    return `${this.directory}/${id}.json`;
  }
  private static async write(record: MergeRecord) {
    await IOUtils.makeDirectory(this.directory, { ignoreExisting: true, permissions: 0o700 });
    const path = this.path(record.id);
    await IOUtils.writeJSON(path, record, { tmpPath: `${path}.tmp`, flush: true });
  }
  static content(item: any): string {
    const json = JSON.parse(JSON.stringify(item.toJSON()));
    // save() updates these transport/ownership fields; all other user data must be unchanged.
    for (const key of ["parentItem", "dateModified", "version"]) delete json[key];
    const sort = (value: any): any => Array.isArray(value) ? value.map(sort)
      : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map(k => [k, sort(value[k])])) : value;
    return JSON.stringify(sort(json));
  }
  private static sourceContent(item: any) {
    const json = JSON.parse(this.content(item));
    delete json.deleted; // Trash/restore changes only this field.
    return JSON.stringify(json);
  }
  private static checkTrashSources(record: MergeRecord, items: any[]) {
    for (const item of items.filter(item => item.id !== record.keeperID)) {
      if (item.getAnnotations(true).length || item.getNotes(true).length || item.getNote().trim()
        || this.sourceContent(item) !== record.sourceContents?.[item.id]) {
        throw new Error("副本内容、批注或笔记已变化，未执行清理或恢复。");
      }
    }
  }
  static async prepareTrash(items: any[], files: DuplicateFile[], title: string, batchID?: string): Promise<MergeRecord> {
    this.assertClosed(items.map(item => item.id));
    const [keeper, ...sources] = items;
    const record: MergeRecord = { schema: 1, kind: "trash", batchID,
      id: Services.uuid.generateUUID().toString().replace(/[{}]/g, ""), createdAt: new Date().toISOString(),
      status: "prepared", libraryID: keeper.libraryID, parentID: keeper.parentID, title, keeperID: keeper.id,
      files: JSON.parse(JSON.stringify(files)), annotations: [], keeperAnnotations: [],
      sourceContents: Object.fromEntries(sources.map(item => [item.id, this.sourceContent(item)])) };
    this.checkTrashSources(record, items);
    return record;
  }
  static async executeTrash(record: MergeRecord, items: any[], validate: () => Promise<void>) {
    await this.write(record);
    try {
      await Zotero.DB.executeTransaction(async () => {
        await validate(); this.assertClosed(items.map(item => item.id)); this.checkTrashSources(record, items);
        const sources = items.filter(item => item.id !== record.keeperID);
        await Zotero.Items.trash(sources.map(item => item.id));
        for (const item of sources) {
          await item.loadAllData(true);
          const expected = record.files.find(file => file.id === item.id)!;
          if (!item.deleted || item.key !== expected.key || item.libraryID !== record.libraryID
            || item.parentID !== record.parentID || item.attachmentPath !== expected.attachmentPath) {
            throw new Error("回收站状态核验失败。");
          }
        }
        this.checkTrashSources(record, items);
      });
    } catch (error) { await this.reload(record); throw error; }
    record.status = "committed";
    let warning = "";
    try { await this.write(record); }
    catch (_) { warning = "清理已完成，但记录完成标记写入失败；可从操作记录核对并恢复。"; }
    return { moved: record.files.length - 1, annotations: 0, recordID: record.id, warning };
  }
  static assertClosed(ids: number[]) {
    const readers = (Zotero.Reader as any)?._readers;
    // Fail closed when a future Zotero version no longer exposes this reader inventory.
    if (!Array.isArray(readers)) throw new Error("无法确认 PDF 阅读器状态；此 Zotero 版本暂不能合并批注。");
    if (readers.some(reader => ids.includes(reader.itemID))) {
      throw new Error("请先关闭本组所有 PDF 阅读器标签页和窗口，再合并或恢复。");
    }
  }
  static reason(item: any): string {
    if (!item.isStoredFileAttachment() || !item.isEditable()) return "仅支持可编辑的本地存储附件";
    const library = Zotero.Libraries.get(item.libraryID);
    if (!library || !library.hasTrash) return "资料库没有可用回收站";
    if (item.getNotes(true).length || item.getNote().trim()) return "附件带笔记，请人工处理";
    for (const annotation of item.getAnnotations(true)) {
      if (!annotation?.isAnnotation?.()) return "无法确认批注类型";
      if (annotation.deleted) return "包含已在回收站中的批注，请人工处理";
      if (annotation.annotationIsExternal) return "包含外部批注，暂不合并";
      if (!annotation.isEditable()) return "存在无编辑权限的批注";
    }
    return "";
  }
  private static async capture(item: any): Promise<MergeAnnotation[]> {
    const rows = [];
    for (const annotation of item.getAnnotations(true)) {
      await annotation.loadAllData();
      if (annotation.deleted || annotation.annotationIsExternal || !annotation.isEditable()
        || annotation.parentID !== item.id || annotation.libraryID !== item.libraryID) {
        throw new Error("批注状态或权限已变化，请重新扫描。");
      }
      rows.push({ id: annotation.id, key: annotation.key, fromID: item.id, content: this.content(annotation) });
    }
    return rows;
  }
  static async prepare(items: any[], files: DuplicateFile[], title: string, batchID?: string): Promise<MergeRecord> {
    this.assertClosed(items.map(item => item.id));
    for (const item of items) {
      const reason = this.reason(item);
      if (reason) throw new Error(`${item.key}：${reason}`);
      // Also detect embedded annotations not yet imported into the Zotero database.
      if (await item.hasEmbeddedAnnotations()) throw new Error(`${item.key} 存在 PDF 内嵌批注，暂不合并。`);
    }
    const [keeper, ...sources] = items;
    const annotations = (await Promise.all(sources.map(item => this.capture(item)))).flat();
    if (!annotations.length) throw new Error("选中副本没有可迁移批注，请使用直接清理。");
    return { schema: 1, kind: "merge", batchID, id: Services.uuid.generateUUID().toString().replace(/[{}]/g, ""),
      createdAt: new Date().toISOString(), status: "prepared", libraryID: keeper.libraryID,
      parentID: keeper.parentID, title, keeperID: keeper.id,
      files: JSON.parse(JSON.stringify(files)), annotations, keeperAnnotations: await this.capture(keeper) };
  }
  private static async verifyAnnotations(rows: MergeAnnotation[], libraryID: number, destination?: number) {
    for (const row of rows) {
      const annotation = await Zotero.Items.getAsync(row.id);
      if (annotation) await annotation.loadAllData();
      if (!annotation || annotation.key !== row.key || !annotation.isAnnotation()
        || annotation.libraryID !== libraryID || annotation.deleted || annotation.annotationIsExternal
        || !annotation.isEditable() || annotation.parentID !== (destination ?? row.fromID)
        || this.content(annotation) !== row.content) {
        throw new Error(`批注 ${row.key} 已变化、缺失或无权限，未执行操作。`);
      }
    }
  }
  private static assertMembership(items: any[], rows: MergeAnnotation[]) {
    for (const item of items) {
      const actual = item.getAnnotations(true).map(a => a.id).sort((a, b) => a - b);
      const expected = rows.filter(row => row.fromID === item.id).map(row => row.id).sort((a, b) => a - b);
      if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error("批注数量已变化，请重新扫描。");
    }
  }
  // Used after failure to discard mutated in-memory fields after DB rollback.
  private static async reload(record: MergeRecord) {
    for (const id of [...record.files.map(f => f.id), ...record.annotations.map(a => a.id)]) {
      const item = await Zotero.Items.getAsync(id);
      if (item) await item.loadAllData(true);
    }
  }
  static async execute(record: MergeRecord, items: any[], validate: () => Promise<void>) {
    await this.write(record); // Must succeed BEFORE the first DB mutation.
    try {
      await Zotero.DB.executeTransaction(async () => {
        await validate();
        this.assertClosed(items.map(item => item.id));
        for (const item of items) { const reason = this.reason(item); if (reason) throw new Error(reason); }
        this.assertMembership(items, [...record.annotations, ...record.keeperAnnotations]);
        await this.verifyAnnotations([...record.annotations, ...record.keeperAnnotations], record.libraryID);
        for (const row of record.annotations) {
          const annotation = await Zotero.Items.getAsync(row.id);
          if (!annotation) throw new Error("批注已不存在。");
          annotation.parentItemID = record.keeperID;
          await annotation.save();
        }
        // Force a database readback; don't just compare the objects we assigned above.
        for (const row of record.annotations) {
          const annotation = await Zotero.Items.getAsync(row.id);
          if (!annotation) throw new Error("批注已不存在。");
          await annotation.loadAllData(true);
        }
        await this.verifyAnnotations(record.annotations, record.libraryID, record.keeperID);
        await this.verifyAnnotations(record.keeperAnnotations, record.libraryID, record.keeperID);
        for (const item of items) await item.loadAllData(true);
        this.assertMembership(items, [...record.annotations.map(row => ({ ...row, fromID: record.keeperID })), ...record.keeperAnnotations]);
        this.assertClosed(items.map(item => item.id));
        await validate();
        await Zotero.Items.trash(record.files.filter(file => file.id !== record.keeperID).map(file => file.id));
      });
    } catch (error) { await this.reload(record); throw error; }
    record.status = "committed";
    let warning = "";
    try { await this.write(record); }
    catch (_) { warning = "合并已完成，但完成标记写入失败；恢复时将依据预写记录核对实际状态。"; }
    return { moved: record.files.length - 1, annotations: record.annotations.length, recordID: record.id, warning };
  }
  static async history(libraryID: number) {
    if (!await IOUtils.exists(this.directory)) return [];
    const records = [];
    for (const path of await IOUtils.getChildren(this.directory)) {
      if (!/\/[a-f0-9-]{36}\.json$/.test(path.replace(/\\/g, "/"))) continue;
      try {
        const record = await IOUtils.readJSON(path) as MergeRecord;
        if (record.schema !== 1 || record.libraryID !== libraryID) continue;
        this.path(record.id);
        records.push({ id: record.id, title: record.title, createdAt: record.createdAt, status: record.status,
          kind: record.kind || "merge", batchID: record.batchID || record.id,
          annotations: record.annotations.length, copies: record.files.length - 1 });
      } catch (_) { throw new Error("合并记录无法读取；请保留记录文件并检查，不要清空回收站。"); }
    }
    return records.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  static async restore(id: string, libraryID: number, confirmation: string, cancelled: () => boolean) {
    if (!["恢复合并", "恢复操作"].includes(confirmation)) throw new Error("请确认恢复操作。");
    const record = await IOUtils.readJSON(this.path(id)) as MergeRecord;
    if (record.schema !== 1 || record.id !== id || record.libraryID !== libraryID
      || (record.kind !== undefined && !["trash", "merge"].includes(record.kind))
      || !["prepared", "committed", "restored"].includes(record.status)) throw new Error("操作记录无效或不属于当前资料库。");
    const parent = await Zotero.Items.getAsync(record.parentID);
    return AttachmentGuard.withItemLock(parent, async () => {
      const checkParent = () => {
        if (cancelled()) throw new Error("操作已取消。");
        if (!parent || parent.deleted || parent.libraryID !== libraryID || !parent.isEditable()) throw new Error("父条目缺失或无权限。");
        this.assertClosed(record.files.map(f => f.id));
      };
      checkParent();
      const items: any[] = [];
      const fileStates = new Map<number, any>();
      for (const file of record.files) {
        const item = await Zotero.Items.getAsync(file.id);
        if (!item || item.key !== file.key || item.parentID !== record.parentID || item.libraryID !== libraryID
          || !item.isPDFAttachment() || !item.isStoredFileAttachment() || !item.isEditable()) {
          throw new Error("附件已永久删除、移动或无权限，无法自动恢复。");
        }
        await item.loadAllData();
        const path = await item.getFilePathAsync();
        if (!path) throw new Error("PDF 没有本地路径，无法恢复。");
        const before = await IOUtils.stat(path);
        if (!path || await AttachmentGuard.sha256(path) !== file.hash) throw new Error("PDF 缺失或内容已变化，无法自动恢复。");
        const after = await IOUtils.stat(path);
        if (before.size !== after.size || before.lastModified !== after.lastModified) throw new Error("PDF 在核验时发生变化。");
        fileStates.set(item.id, { path, attachmentPath: item.attachmentPath, size: after.size, modified: after.lastModified, key: item.key });
        items.push(item);
      }
      const keeper = items.find(item => item.id === record.keeperID);
      if (!keeper || keeper.deleted) throw new Error("保留附件已在回收站或缺失，请先处理后续操作。");
      const sources = items.filter(item => item.id !== record.keeperID);
      const verifyFiles = async (restored = false) => {
        checkParent();
        for (const item of items) {
          const expected = fileStates.get(item.id);
          const stat = await IOUtils.stat(expected.path);
          if (await item.getFilePathAsync() !== expected.path || item.attachmentPath !== expected.attachmentPath
            || item.key !== expected.key || item.parentID !== record.parentID || item.libraryID !== libraryID
            || !item.isEditable() || !item.isPDFAttachment() || !item.isStoredFileAttachment()
            || (item.id === record.keeperID || restored ? item.deleted : !item.deleted)
            || stat.size !== expected.size || stat.lastModified !== expected.modified) throw new Error("附件状态或文件已变化，未恢复。");
        }
      };
      if (record.kind === "trash") this.checkTrashSources(record, items);
      const alreadyOriginal = sources.every(item => !item.deleted)
        && (await Promise.all(record.annotations.map(row => Zotero.Items.getAsync(row.id))))
          .every((item, index) => item && item.parentID === record.annotations[index].fromID);
      if (alreadyOriginal) {
        await this.verifyAnnotations(record.annotations, libraryID);
        record.status = "restored"; await this.write(record);
        return "记录对应的附件和批注已处于合并前状态；未修改资料库。";
      }
      if (record.status === "restored" || sources.some(item => !item.deleted)) {
        throw new Error("附件状态与合并记录不一致（可能已手动恢复），请人工核对。");
      }
      try {
        await Zotero.DB.executeTransaction(async () => {
          await verifyFiles();
          if (record.kind === "trash") this.checkTrashSources(record, items);
          await this.verifyAnnotations(record.annotations, libraryID, record.keeperID);
          for (const item of sources) { item.deleted = false; await item.save(); }
          for (const row of record.annotations) {
            const annotation = await Zotero.Items.getAsync(row.id);
            if (!annotation) throw new Error("批注已不存在。");
            annotation.parentItemID = row.fromID; await annotation.save();
          }
          for (const row of record.annotations) {
            const annotation = await Zotero.Items.getAsync(row.id);
            if (!annotation) throw new Error("批注已不存在。");
            await annotation.loadAllData(true);
          }
          await this.verifyAnnotations(record.annotations, libraryID);
          for (const item of sources) await item.loadAllData(true);
          await verifyFiles(true);
          if (record.kind === "trash") this.checkTrashSources(record, items);
        });
      } catch (error) { await this.reload(record); throw error; }
      record.status = "restored";
      try { await this.write(record); }
      catch (_) { return "附件和批注已恢复；记录标记写入失败。再次检查恢复可识别已恢复状态。"; }
      return `已恢复 ${sources.length} 个附件，并将 ${record.annotations.length} 条批注移回原附件。`;
    });
  }
}
