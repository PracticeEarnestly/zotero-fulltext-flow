import { PREF_PREFIX } from "../config";
import type { FlowEngine } from "./FlowEngine";
import { extractItemMetadata } from "./Metadata";
import { hasUsablePDF } from "./AttachmentDetector";

export class AutoWatcher {
  private observerID: any = null;
  constructor(private engine: FlowEngine) {}

  start() {
    if (this.observerID) return;
    const observer = {
      notify: async (event: string, type: string, ids: number[]) => {
        if (type !== "item" || !["add", "modify"].includes(event)) return;
        const auto = this.autoCollections();
        if (!auto.size) return;
        for (const id of ids || []) {
          const item: any = Zotero.Items.get(id);
          if (!item?.isRegularItem?.() || await hasUsablePDF(item)) continue;
          const memberships: number[] = item.getCollections?.() || [];
          let enabled = false;
          for (const cid of memberships) {
            const c: any = Zotero.Collections.get(cid);
            if (c && auto.has(`${c.libraryID}:${c.key}`)) { enabled = true; break; }
          }
          if (!enabled) continue;
          const metadata = extractItemMetadata(item);
          if (metadata.queryText) await this.engine.enqueueMetadata([metadata]);
        }
      }
    };
    this.observerID = Zotero.Notifier.registerObserver(observer as any, ["item"], "fulltextflow", 1);
  }

  stop() {
    if (this.observerID) Zotero.Notifier.unregisterObserver(this.observerID);
    this.observerID = null;
  }

  private autoCollections(): Set<string> {
    try {
      const value = JSON.parse(String(Zotero.Prefs.get(`${PREF_PREFIX}.autoCollections`) || "[]"));
      return new Set(Array.isArray(value) ? value : []);
    } catch (_) { return new Set(); }
  }
}
