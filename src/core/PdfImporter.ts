import type { QueueEntry } from "./QueueStore";
import { PdfVerifier, type VerificationResult } from "./PdfVerifier";

export type ImportResult = {
  attachment: any;
  verification: VerificationResult;
};

export class PdfImporter {
  static async importFromURL(item: any, entry: QueueEntry, url: string): Promise<ImportResult> {
    const attachment: any = await Zotero.Attachments.importFromURL({
      libraryID: item.libraryID,
      url,
      parentItemID: item.id,
      title: entry.title || item.getDisplayTitle?.() || "Full Text PDF",
      fileBaseName: this.fileBaseName(entry),
      contentType: "application/pdf",
      referrer: "",
      cookieSandbox: null
    } as any);

    try {
      const verification = await PdfVerifier.verify(attachment, entry);
      return { attachment, verification };
    }
    catch (error) {
      // Structural PDF failures are unsafe to keep.
      await attachment.eraseTx?.();
      throw error;
    }
  }

  private static fileBaseName(entry: QueueEntry): string {
    return String(entry.title || entry.queryText || entry.itemKey)
      .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 120) || "FullTextFlow";
  }
}
