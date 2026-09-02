import { PREF_PREFIX } from "../config";
import { PubMedQA } from "./PubMedQA";

export class PubMedWatcher {
  private observerID: any = null;
  private timers = new Map<number, ReturnType<typeof setTimeout>>();
  private processing = new Set<number>();

  start() {
    if (this.observerID) return;
    const observer = {
      notify: async (event: string, type: string, ids: number[]) => {
        if (type !== "item" || !["add", "modify"].includes(event)) return;
        if (!this.enabled()) return;
        for (const id of ids || []) this.schedule(Number(id));
      }
    };
    this.observerID = Zotero.Notifier.registerObserver(observer as any, ["item"], "fulltextflow-pubmed", 1);
  }

  stop() {
    if (this.observerID) Zotero.Notifier.unregisterObserver(this.observerID);
    this.observerID = null;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.processing.clear();
  }

  private enabled(): boolean {
    const value = Zotero.Prefs.get(`${PREF_PREFIX}.pubmedAutoIdentifiers`);
    return value === undefined || value === null ? true : Boolean(value);
  }

  private schedule(id: number) {
    const prior = this.timers.get(id);
    if (prior) clearTimeout(prior);
    const timer = setTimeout(() => {
      this.timers.delete(id);
      void this.process(id);
    }, 1500);
    this.timers.set(id, timer);
  }

  private async process(id: number) {
    if (this.processing.has(id) || !this.enabled()) return;
    const item: any = Zotero.Items.get(id);
    if (!item?.isRegularItem?.()) return;

    // No title-only matching in automatic mode. This avoids silently attaching a PMID
    // to the wrong article when imported metadata are incomplete.
    const doi = String(item.getField?.("DOI") || "").trim();
    const extra = String(item.getField?.("extra") || "");
    const pmid = extra.match(/(?:^|\n)\s*PMID\s*:\s*(\d+)/i)?.[1] || "";
    const pmcid = extra.match(/(?:^|\n)\s*PMCID\s*:\s*(PMC\d+)/i)?.[1] || "";
    if ((!doi && !pmid) || (pmid && pmcid)) return;

    this.processing.add(id);
    try {
      const outcome = await PubMedQA.completeIdentifiers(item);
      if (["updated", "conflict", "error"].includes(outcome.status)) {
        Zotero.debug(`FullTextFlow PubMed auto-ID ${item.key || id}: ${outcome.status} - ${outcome.message}`);
      }
    } catch (e) {
      Zotero.debug(`FullTextFlow PubMed auto-ID failed for ${item.key || id}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      this.processing.delete(id);
    }
  }
}
