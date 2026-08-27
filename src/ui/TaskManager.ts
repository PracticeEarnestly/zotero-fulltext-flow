import { PLUGIN_NAME, PREF_PREFIX } from "../config";
import { QueueStore } from "../core/QueueStore";
import type { FlowEngine } from "../core/FlowEngine";

export class TaskManager {
  static open(win: any, engine: FlowEngine) {
    const existing = Services.wm.getMostRecentWindow("fulltextflow:tasks");
    if (existing) {
      existing.focus();
      existing.FullTextFlowTasks?.refresh?.();
      return;
    }

    const bridge = {
      pluginName: PLUGIN_NAME,
      pollMinutes: Math.max(1, Number(Zotero.Prefs.get(`${PREF_PREFIX}.pollMinutes`) || 5)),
      getRows: () => QueueStore.load().map(e => ({
        itemKey: e.itemKey,
        libraryID: e.libraryID,
        title: e.title || e.queryText,
        queryText: e.queryText,
        state: e.state,
        source: e.source || "",
        verification: e.verification || "",
        reason: e.verificationReason || e.error || e.cancelNote || e.nativeError || "",
        createdAt: e.createdAt,
        submittedAt: e.submittedAt || "",
        updatedAt: e.updatedAt,
        lastCheckedAt: e.lastCheckedAt || "",
        nextCheckAt: e.nextCheckAt || "",
        taskCode: e.taskCode || "",
        remoteTaskStatus: e.remoteTaskStatus || "",
        remoteTaskStatusLabel: e.remoteTaskStatusLabel || "",
        remoteCreateTime: e.remoteCreateTime || "",
        cancelledAt: e.cancelledAt || "",
        cancelNote: e.cancelNote || ""
      })),
      poll: async () => {
        await engine.poll();
        return QueueStore.load();
      },
      clearCompleted: () => QueueStore.clearCompleted(),
      clearCancelled: () => QueueStore.clearCancelled(),
      clearFinished: () => QueueStore.clearFinished(),
      retryProblems: async () => engine.retryProblemEntries(),
      cancelOne: (itemKey: string, libraryID: number) => engine.cancelEntry(itemKey, Number(libraryID)),
      cancelAll: () => engine.cancelAllActive()
    };

    win.openDialog(
      "chrome://fulltextflow/content/task-manager.xhtml",
      "fulltextflow-task-manager",
      "chrome,centerscreen,resizable,width=1380,height=720",
      { wrappedJSObject: bridge }
    );
  }
}
