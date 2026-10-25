import { PLUGIN_NAME, PREF_PREFIX } from "../config";
import { QueueStore } from "../core/QueueStore";
import { AuthManager } from "../core/AuthManager";
import { retrievalStrategyLabel } from "../core/RetrievalStrategy";
import type { FlowEngine } from "../core/FlowEngine";
import type { QueueTarget } from "../core/QueueStore";
import { isClearableState, isRetryableState, isTerminalState } from "../core/QueueStates";
import { AuthWindow } from "./AuthWindow";
import { DuplicateManager } from "./DuplicateManager";
import { isDailyQuotaError } from "../core/QuotaRetry";

export class TaskManager {
  static open(win: any, engine: FlowEngine) {
    const existing = Services.wm.getMostRecentWindow("fulltextflow:tasks") as any;
    if (existing) {
      existing.focus?.();
      existing.FullTextFlowTasks?.refresh?.();
      return;
    }

    const bridge = {
      pluginName: PLUGIN_NAME,
      pollMinutes: Math.max(1, Number(Zotero.Prefs.get(`${PREF_PREFIX}.pollMinutes`) || 5)),
      pendingWarnHours: Math.max(1, Number(Zotero.Prefs.get(`${PREF_PREFIX}.pendingWarnHours`) || 24)),
      getOverview: async () => ({
        strategyLabel: retrievalStrategyLabel(),
        hasToken: await AuthManager.hasToken(),
        hasCredentials: await AuthManager.hasCredentials(),
        active: QueueStore.active().length,
        counts: QueueStore.countByState()
      }),
      getRows: () => QueueStore.load().map(e => ({
        itemKey: e.itemKey,
        libraryID: e.libraryID,
        title: e.title || e.queryText,
        queryText: e.queryText,
        state: e.state,
        canCancel: !isTerminalState(e.state),
        canRetry: isRetryableState(e.state),
        canClear: isClearableState(e.state),
        canRecheck: e.state === "review",
        canScheduleQuota: e.state === "failed" && !e.submittedAt && !e.taskUUID && !e.taskCode
          && isDailyQuotaError(`${e.error || ""} ${e.diagnosticMessage || ""}`),
        source: e.source || "",
        verification: e.verification || "",
        reason: e.verificationReason || e.error || e.cancelNote || e.nativeError || "",
        createdAt: e.createdAt,
        submittedAt: e.submittedAt || "",
        updatedAt: e.updatedAt,
        lastCheckedAt: e.lastCheckedAt || "",
        nextCheckAt: e.nextCheckAt || "",
        retryAfter: e.retryAfter || "",
        taskCode: e.taskCode || "",
        remoteTaskStatus: e.remoteTaskStatus || "",
        remoteTaskStatusLabel: e.remoteTaskStatusLabel || "",
        remoteCreateTime: e.remoteCreateTime || "",
        matchStrategy: e.matchStrategy || "",
        lastMatchedAt: e.lastMatchedAt || "",
        unmatchedPolls: Number(e.unmatchedPolls || 0),
        firstUnmatchedAt: e.firstUnmatchedAt || "",
        diagnosticLevel: e.diagnosticLevel || "",
        diagnosticMessage: e.diagnosticMessage || "",
        cancelledAt: e.cancelledAt || "",
        cancelNote: e.cancelNote || ""
      })),
      poll: async () => {
        await engine.poll();
        return QueueStore.load();
      },
      clearSelected: (targets: QueueTarget[]) => QueueStore.clearSelected(targets),
      retrySelected: (targets: QueueTarget[]) => engine.retryProblemEntries(targets),
      recheckSelected: (targets: QueueTarget[]) => engine.recheckSelected(targets),
      confirmReviewed: (targets: QueueTarget[]) => engine.confirmReviewed(targets),
      scheduleQuotaSelected: (targets: QueueTarget[]) => engine.scheduleQuotaSelected(targets),
      openLogin: () => AuthWindow.open(win, engine),
      openDuplicates: () => DuplicateManager.open(win),
      locate: async (itemKey: string, libraryID: number) => {
        const entry = QueueStore.find(itemKey, Number(libraryID));
        if (!entry || !Zotero.Items.get(entry.itemID)) throw new Error("Zotero 条目已不存在。");
        win.focus();
        await win.ZoteroPane.selectItem(entry.itemID);
      },
      cancelOne: (itemKey: string, libraryID: number) => engine.cancelEntry(itemKey, Number(libraryID)),
      cancelAll: () => engine.cancelAllActive()
    };

    win.openDialog(
      "chrome://fulltextflow/content/task-manager.xhtml",
      "fulltextflow-task-manager",
      "chrome,centerscreen,resizable,width=1540,height=760",
      { wrappedJSObject: bridge }
    );
  }
}
