import { hasUsablePDF } from "./AttachmentDetector";
import { extractItemMetadata, type ItemMetadata } from "./Metadata";

export type ScanResult = {
  total: number;
  regular: number;
  withPDF: number;
  missingPDF: ItemMetadata[];
  noIdentifier: number;
};

export class CollectionScanner {
  static async collectItems(collection: any, recursive: boolean): Promise<any[]> {
    const map = new Map<string, any>();
    const visit = async (c: any) => {
      const children = await Promise.resolve(c.getChildItems?.(false, false) || []);
      for (const item of children) {
        const resolved = typeof item === "number" ? Zotero.Items.get(item) : item;
        if (resolved) map.set(`${resolved.libraryID}:${resolved.key || resolved.id}`, resolved);
      }
      if (!recursive) return;
      const subcollections = await Promise.resolve(c.getChildCollections?.(false) || []);
      for (const sub of subcollections) {
        const resolved = typeof sub === "number" ? Zotero.Collections.get(sub) : sub;
        if (resolved) await visit(resolved);
      }
    };
    await visit(collection);
    return Array.from(map.values());
  }

  static async scan(collection: any, recursive: boolean): Promise<ScanResult> {
    const items = await this.collectItems(collection, recursive);
    const result: ScanResult = { total: items.length, regular: 0, withPDF: 0, missingPDF: [], noIdentifier: 0 };
    for (const item of items) {
      if (!item?.isRegularItem?.()) continue;
      result.regular++;
      if (await hasUsablePDF(item)) {
        result.withPDF++;
        continue;
      }
      const metadata = extractItemMetadata(item);
      if (!metadata.queryText) {
        result.noIdentifier++;
        continue;
      }
      result.missingPDF.push(metadata);
    }
    return result;
  }
}
