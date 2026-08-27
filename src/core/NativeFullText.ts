import { hasUsablePDF } from "./AttachmentDetector";

export type NativeLookupResult = {
  found: boolean;
  attachmentID?: number;
  error?: string;
};

/**
 * Reuse Zotero's own Find Full Text machinery before falling back to JLSS.
 * This intentionally delegates DOI/URL/OA/custom-resolver handling to Zotero.
 */
export class NativeFullText {
  static async tryFind(item: any): Promise<NativeLookupResult> {
    try {
      if (!item?.isRegularItem?.()) return { found: false };
      if (await hasUsablePDF(item)) return { found: true };

      const attachments: any = (Zotero as any).Attachments;
      if (!attachments?.addAvailableFile) {
        return { found: false, error: "当前 Zotero 版本不提供 addAvailableFile()。" };
      }
      if (attachments.canFindFileForItem && !attachments.canFindFileForItem(item)) {
        return { found: false };
      }

      const attachment = await attachments.addAvailableFile(item, {
        methods: ["doi", "url", "oa", "custom"]
      });
      if (!attachment) return { found: false };

      const found = await hasUsablePDF(item);
      return {
        found,
        attachmentID: Number(attachment.id || 0) || undefined
      };
    }
    catch (error) {
      // Native lookup errors should not block the JLSS fallback.
      return {
        found: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }
}
