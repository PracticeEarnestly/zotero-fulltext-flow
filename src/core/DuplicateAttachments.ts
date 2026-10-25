import { AttachmentGuard } from "./AttachmentGuard";
import { AnnotationMerge } from "./AnnotationMerge";

export interface DuplicateFile {
  id: number; key: string; libraryID: number; parentID: number;
  title: string; path: string; attachmentPath: string; size: number; modified: number; hash: string;
  annotations: number; notes: number; protectedReason: string; mergeReason: string;
}
export interface DuplicateGroup {
  id: string; parentID: number; libraryID: number; title: string; files: DuplicateFile[];
}

// A window owns its scan snapshots. Requests cannot supply arbitrary attachment IDs.
export class DuplicateAttachments {
  private groups = new Map<string, DuplicateGroup>();
  private busy = false;
  private stopped = false;
  private batchID?: string;
  beginBatch() {
    if (this.busy || this.stopped) throw new Error("请完成扫描后再开始操作。");
    this.batchID = Services.uuid.generateUUID().toString().replace(/[{}]/g, "");
  }
  cancel() { this.stopped = true; }
  private checkCancelled() { if (this.stopped) throw new Error("扫描已取消；未修改任何附件。"); }

  private protection(item: any) {
    const annotations = item.getAnnotations(true).length;
    const notes = item.getNotes(true).length + (item.getNote().trim() ? 1 : 0);
    const library = Zotero.Libraries.get(item.libraryID);
    const protectedReason = annotations || notes ? "有批注或笔记（包括回收站中的），请人工处理"
      : !item.isStoredFileAttachment() ? "链接文件仅展示，不在此清理"
      : !item.isEditable() || !library || !library.hasTrash ? "无编辑权限或资料库无回收站" : "";
    return { annotations, notes, protectedReason, mergeReason: AnnotationMerge.reason(item) };
  }

  private async inspect(item: any, parent: any, hash = false): Promise<DuplicateFile> {
    if (!item || item.deleted || !item.isPDFAttachment() || item.parentID !== parent.id
      || item.libraryID !== parent.libraryID) throw new Error("附件已删除、移动或不再是 PDF，请重新扫描。");
    await item.loadAllData();
    const path = await item.getFilePathAsync();
    if (!path) throw new Error("附件没有本地文件。");
    const before = await IOUtils.stat(path);
    if (before.type !== "regular" || !before.size) throw new Error("附件文件不可用。");
    const result: DuplicateFile = { id: item.id, key: item.key, libraryID: item.libraryID,
      parentID: parent.id, title: String(item.getField("title") || item.key), path, attachmentPath: item.attachmentPath,
      size: before.size, modified: before.lastModified, hash: "", ...this.protection(item) };
    if (hash) {
      const magic = await IOUtils.read(path, { maxBytes: 5 });
      if (Array.from(magic).map((b: number) => String.fromCharCode(b)).join("") !== "%PDF-") {
        throw new Error("文件不是有效的 PDF 文件头。");
      }
      result.hash = await AttachmentGuard.sha256(path);
      const after = await IOUtils.stat(path);
      if (before.size !== after.size || before.lastModified !== after.lastModified) {
        throw new Error("文件在核验过程中发生变化，请重新扫描。");
      }
    }
    return result;
  }

  async scan(source: any[] | (() => Promise<any[]>), progress: (text: string) => void = () => {}) {
    if (this.busy) throw new Error("已有操作正在进行。");
    this.busy = true; this.stopped = false; this.batchID = undefined; this.groups.clear();
    const groups: DuplicateGroup[] = [], skipped: string[] = [];
    let checked = 0;
    try {
      const parents = typeof source === "function" ? await source() : source;
      this.checkCancelled();
      const unique = [...new Map(parents.filter(p => p && !p.deleted && p.isRegularItem()).map(p => [p.id, p])).values()];
      for (const parent of unique) {
        this.checkCancelled();
        progress(`正在扫描 ${++checked} / ${unique.length} 个条目…`);
        await Zotero.Promise.delay(0);
        try {
          await parent.loadAllData();
          const attachments = await Zotero.Items.getAsync(parent.getAttachments() as number[]);
          const sizes = new Map<number, DuplicateFile[]>();
          for (const item of attachments) {
            this.checkCancelled();
            if (!item || item.deleted || !item.isPDFAttachment()) continue;
            try {
              const file = await this.inspect(item, parent);
              sizes.set(file.size, [...(sizes.get(file.size) || []), file]);
            } catch (error) { skipped.push(`${item.key}：${error.message || error}`); }
          }
          for (const candidates of sizes.values()) {
            if (candidates.length < 2) continue;
            const hashes = new Map<string, DuplicateFile[]>();
            for (const candidate of candidates) {
              this.checkCancelled();
              await Zotero.Promise.delay(0);
              try {
                const file = await this.inspect(await Zotero.Items.getAsync(candidate.id), parent, true);
                const key = `${file.size}:${file.hash}`;
                hashes.set(key, [...(hashes.get(key) || []), file]);
              } catch (error) { skipped.push(`${candidate.key}：${error.message || error}`); }
            }
            for (const files of hashes.values()) {
              if (files.length < 2) continue;
              for (const file of files) {
                if (files.some(other => other.id !== file.id && other.path === file.path)) {
                  file.protectedReason = "多个附件指向同一路径，请人工处理";
                  file.mergeReason = file.protectedReason;
                }
              }
              groups.push({ id: `${parent.libraryID}:${parent.id}:${files[0].hash}`, parentID: parent.id,
                libraryID: parent.libraryID, title: String(parent.getField("title") || parent.key), files });
            }
          }
        } catch (error) {
          this.checkCancelled(); skipped.push(`${parent.key}：${error.message || error}`);
        }
      }
      this.checkCancelled();
      for (const group of groups) this.groups.set(group.id, group);
      // Return detached data so changes in the UI cannot change the trusted snapshots.
      return JSON.parse(JSON.stringify({ groups, skipped, checked }));
    } finally { this.busy = false; }
  }

  async trash(groupID: string, keeperID: number, removeIDs: number[], confirmation: string, merge = false) {
    if (this.busy) throw new Error("已有操作正在进行。");
    const group = this.groups.get(groupID);
    const ids = [...new Set(removeIDs)];
    if (confirmation !== (merge ? "合并批注并清理" : "移入回收站") || !group || !ids.length || ids.includes(keeperID)
      || !group.files.some(f => f.id === keeperID) || ids.some(id => !group.files.some(f => f.id === id))) {
      throw new Error("请选择一份保留附件和要移入回收站的副本，并确认操作。");
    }
    this.busy = true;
    try {
      const parent = await Zotero.Items.getAsync(group.parentID);
      return await AttachmentGuard.withItemLock(parent, async () => {
        if (this.stopped) throw new Error("窗口已关闭或操作已取消，请重新扫描。");
        if (!parent || parent.deleted || !parent.isRegularItem() || parent.libraryID !== group.libraryID || !parent.isEditable()) {
          throw new Error("父条目已变化或不可编辑，请重新扫描。");
        }
        const live: any[] = [];
        const verified: DuplicateFile[] = [];
        for (const id of [keeperID, ...ids]) {
          const item = await Zotero.Items.getAsync(id);
          const file = await this.inspect(item, parent, true);
          const snapshot = group.files.find(f => f.id === id)!;
          if (["key", "path", "attachmentPath", "size", "modified", "hash"].some(key => file[key] !== snapshot[key])) {
            throw new Error(`${snapshot.key} 在扫描后发生变化，请重新扫描。`);
          }
          if (merge) {
            if (file.mergeReason) throw new Error(`${file.key}：${file.mergeReason}`);
            if (file.annotations !== snapshot.annotations) throw new Error("批注数量在扫描后变化，请重新扫描。");
          } else if (id !== keeperID && file.protectedReason) throw new Error(`${file.key}：${file.protectedReason}`);
          if (id !== keeperID && group.files.filter(f => f.path === file.path).length > 1) {
            throw new Error("多个附件指向同一路径，不能在此清理。");
          }
          verified.push(file);
          live.push(item);
        }
        // Recheck metadata after hashing and within the DB transaction. No erase or file removal.
        const validate = async () => {
          for (const file of verified) {
            const stat = await IOUtils.stat(file.path);
            if (stat.size !== file.size || stat.lastModified !== file.modified) {
              throw new Error("文件在核验过程中发生变化，请重新扫描。");
            }
          }
          if (this.stopped) throw new Error("窗口已关闭或操作已取消，请重新扫描。");
          if (parent.deleted || !parent.isEditable()) throw new Error("父条目状态已变化。");
          for (const item of live) {
            const file = verified.find(file => file.id === item.id)!;
            if (item.deleted || item.parentID !== parent.id || item.libraryID !== group.libraryID
              || !item.isPDFAttachment() || item.key !== file.key || item.attachmentPath !== file.attachmentPath) {
              throw new Error("附件状态已变化，请重新扫描。");
            }
            if (merge ? AnnotationMerge.reason(item) : item.id !== keeperID && this.protection(item).protectedReason) {
              throw new Error("附件新增批注、笔记或权限已变化，请重新扫描。");
            }
          }
        };
        let result: any = ids.length;
        if (merge) {
          const record = await AnnotationMerge.prepare(live, verified, group.title, this.batchID);
          result = await AnnotationMerge.execute(record, live, validate);
        } else {
          const record = await AnnotationMerge.prepareTrash(live, verified, group.title, this.batchID);
          result = await AnnotationMerge.executeTrash(record, live, validate);
        }
        this.groups.delete(groupID);
        return result;
      });
    } finally { this.busy = false; }
  }

  history(libraryID: number) { return AnnotationMerge.history(libraryID); }
  async notes(groupID: string) {
    const group = this.groups.get(groupID);
    if (!group || this.busy || this.stopped) throw new Error("请完成扫描后查看笔记。");
    const result = [];
    for (const file of group.files) {
      const item = await Zotero.Items.getAsync(file.id);
      if (!item || item.key !== file.key || item.deleted || item.parentID !== group.parentID
        || item.libraryID !== group.libraryID) throw new Error("附件已变化，请重新扫描。");
      await item.loadAllData();
      const notes = [];
      if (item.getNote().trim()) notes.push({ key: item.key, deleted: false, html: item.getNote() });
      for (const id of item.getNotes(true)) {
        const note = await Zotero.Items.getAsync(id);
        if (!note || !note.isNote() || note.parentID !== item.id || note.libraryID !== group.libraryID) {
          throw new Error("笔记归属已变化，请重新扫描。");
        }
        await note.loadAllData();
        notes.push({ key: note.key, deleted: !!note.deleted, html: note.getNote() });
      }
      result.push({ key: item.key, title: String(item.getField("title") || item.key), notes });
    }
    return result;
  }
  async restore(id: string, libraryID: number, confirmation: string) {
    if (this.busy || this.stopped) throw new Error("操作正在进行或窗口已关闭，请重新打开窗口。");
    this.busy = true;
    try { return await AnnotationMerge.restore(id, libraryID, confirmation, () => this.stopped); }
    finally { this.busy = false; this.groups.clear(); }
  }
}
