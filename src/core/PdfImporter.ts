import type { QueueEntry } from "./QueueStore";
import { PdfVerifier, type VerificationResult } from "./PdfVerifier";
import { localPDFAttachments } from "./AttachmentDetector";
import { AttachmentGuard } from "./AttachmentGuard";
import { QueueStore } from "./QueueStore";

export type ImportResult = {
  attachment: any;
  verification: VerificationResult;
  reused?: boolean;
};

export class PdfImporter {
  static async importFromURL(item: any, entry: QueueEntry, url: string): Promise<ImportResult> {
    return AttachmentGuard.withItemLock(item, () => this.importLocked(item, entry, url));
  }

  private static checkCancelled(entry: QueueEntry) {
    if (QueueStore.isCancelled(entry.itemKey, entry.libraryID)) throw new Error("任务已停止，未导入新的附件。");
  }

  private static reuse(attachment: any, reason: string, needsReview = false): ImportResult {
    return { attachment, reused: true, verification: { status: needsReview ? "review" : "inconclusive", reason } };
  }

  private static async importLocked(item: any, entry: QueueEntry, url: string): Promise<ImportResult> {
    this.checkCancelled(entry);
    const existing = (await localPDFAttachments(item))[0];
    if (existing) return this.reuse(existing.attachment, "条目已有本地 PDF，已跳过重复下载；原附件保留。");

    const directory = await Zotero.Attachments.createTemporaryStorageDirectory();
    const file = directory.clone();
    const filename = `FullTextFlow-${this.fileBaseName(entry)}.pdf`;
    file.append(filename);
    try {
      this.checkCancelled(entry);
      await Zotero.Attachments.downloadFile(url, file.path, { referrer: "" });
      this.checkCancelled(entry);
      await PdfVerifier.verifyStructure(file.path);
      const digest = await AttachmentGuard.sha256(file.path);

      // Another plugin or sync may have supplied a PDF during the download.
      const siblings = await localPDFAttachments(item);
      for (const sibling of siblings) {
        if (await AttachmentGuard.sha256(sibling.path) === digest) {
          return this.reuse(sibling.attachment, "下载内容与现有 PDF 的 SHA-256 相同，已丢弃临时副本并复用原附件。");
        }
      }
      // Even a different PDF is preserved; don't overwrite or add another full text.
      const latest = (await localPDFAttachments(item))[0];
      if (latest) return this.reuse(latest.attachment, "下载期间条目已新增本地 PDF，已保留原附件并跳过本次导入；请核对现有全文。", true);
      this.checkCancelled(entry);
      const attachment: any = await Zotero.Attachments.createURLAttachmentFromTemporaryStorageDirectory({
        directory: directory.path, filename, libraryID: item.libraryID, parentItemID: item.id,
        url, title: entry.title || item.getDisplayTitle?.() || "Full Text PDF", contentType: "application/pdf"
      });
      try {
        const verification = await PdfVerifier.verify(attachment, entry);
        return { attachment, verification };
      }
      catch (error) {
        // Structure was checked before import. Never erase a committed attachment
        // on an indexing/verification error (it may already have annotations).
        return { attachment, verification: { status: "review", reason: `附件已保留，需复核：${error instanceof Error ? error.message : String(error)}` } };
      }
    }
    finally {
      // Only the directory created by this call is eligible for removal. On
      // successful import Zotero has already moved it to the attachment directory.
      try { await IOUtils.remove(directory.path, { recursive: true, ignoreAbsent: true }); }
      catch (error) { Zotero.logError(error); }
    }
  }

  private static fileBaseName(entry: QueueEntry): string {
    return String(entry.title || entry.queryText || entry.itemKey)
      .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 60) || "FullTextFlow";
  }
}
