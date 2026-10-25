import { DuplicateAttachments } from "../core/DuplicateAttachments";

export class DuplicateManager {
  static open(win: any) {
    const existing = Services.wm.getMostRecentWindow("fulltextflow:duplicates") as any;
    if (existing) { existing.focus(); return; }
    const scanner = new DuplicateAttachments();
    const libraryID = win.ZoteroPane.getSelectedLibraryID();
    const library = Zotero.Libraries.get(libraryID);
    if (!library) throw new Error("请先在 Zotero 中选择一个资料库。");
    const selectedIDs: number[] = (win.ZoteroPane.getSelectedItems() || []).map((item: any) => item.parentID || item.id);
    const bridge = {
      scopeLabel: `${library.name}（打开窗口时的资料库）`,
      selectedCount: new Set(selectedIDs).size,
      scan: (scope: string, progress: (text: string) => void) => scanner.scan(async () => {
        const parents = scope === "selected" ? await Zotero.Items.getAsync(selectedIDs)
          : await Zotero.Items.getAll(libraryID, true, false);
        return parents.filter((item: any) => item.libraryID === libraryID);
      }, progress),
      cancel: () => scanner.cancel(),
      beginBatch: () => scanner.beginBatch(),
      notes: (group: string) => scanner.notes(group),
      trash: (group: string, keeper: number, ids: number[], confirmation: string) => scanner.trash(group, keeper, ids, confirmation),
      merge: (group: string, keeper: number, ids: number[], confirmation: string) => scanner.trash(group, keeper, ids, confirmation, true),
      history: () => scanner.history(libraryID),
      restore: (id: string, confirmation: string) => scanner.restore(id, libraryID, confirmation),
      open: (id: number) => win.ZoteroPane.viewAttachment(id),
      locate: async (id: number) => { win.focus(); await win.ZoteroPane.selectItem(id); }
    };
    win.openDialog("chrome://fulltextflow/content/duplicate-manager.xhtml", "fulltextflow-duplicate-manager",
      "chrome,centerscreen,resizable,width=1080,height=760", { wrappedJSObject: bridge });
  }
  static close() {
    (Services.wm.getMostRecentWindow("fulltextflow:duplicates") as any)?.close();
  }
}
