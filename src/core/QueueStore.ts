import { PREF_PREFIX } from "../config";
import type { ItemMetadata } from "./Metadata";
import type { VerificationStatus } from "./PdfVerifier";
import type { RetrievalStrategy } from "./RetrievalStrategy";

export type QueueState =
  | "queued"
  | "native_search"
  | "waiting_auth"
  | "submitted"
  | "pending"
  | "downloading"
  | "done"
  | "review"
  | "failed"
  | "cancelled";

export type QueueSource = "zotero" | "jlss" | null;
export type DiagnosticLevel = "info" | "warning" | null;

export type QueueEntry = {
  itemID: number;
  itemKey: string;
  libraryID: number;
  queryText: string;
  queryType: string | null;
  doi: string;
  pmid: string;
  title: string;
  state: QueueState;
  source: QueueSource;
  retrievalStrategy?: RetrievalStrategy;
  createdAt: string;
  submittedAt?: string;
  updatedAt: string;
  lastCheckedAt?: string;
  nextCheckAt?: string;
  taskUUID?: string;
  resourceUUID?: string;
  taskCode?: string;
  remoteTaskStatus?: string;
  remoteTaskStatusLabel?: string;
  remoteCreateTime?: string;
  matchStrategy?: string;
  lastMatchedAt?: string;
  unmatchedPolls?: number;
  firstUnmatchedAt?: string;
  diagnosticLevel?: DiagnosticLevel;
  diagnosticMessage?: string;
  attachmentID?: number;
  verification?: VerificationStatus;
  verificationReason?: string;
  nativeError?: string;
  error?: string;
  cancelledAt?: string;
  cancelNote?: string;
};

const TERMINAL_STATES: QueueState[] = ["done", "review", "failed", "cancelled"];

export class QueueStore {
  static load(): QueueEntry[] {
    const raw = String(Zotero.Prefs.get(`${PREF_PREFIX}.queue`) || "[]");
    try {
      const value = JSON.parse(raw);
      if (!Array.isArray(value)) return [];
      return value.map((e: any) => ({
        source: null,
        doi: "",
        pmid: "",
        unmatchedPolls: 0,
        diagnosticLevel: null,
        createdAt: e.createdAt || e.updatedAt || new Date().toISOString(),
        ...e
      }));
    }
    catch (_) {
      return [];
    }
  }

  static save(entries: QueueEntry[]) {
    Zotero.Prefs.set(`${PREF_PREFIX}.queue`, JSON.stringify(entries));
  }

  static find(itemKey: string, libraryID: number): QueueEntry | undefined {
    return this.load().find(e => e.itemKey === itemKey && e.libraryID === libraryID);
  }

  static upsert(metadata: ItemMetadata): QueueEntry {
    const entries = this.load();
    const existing = entries.find(e => e.libraryID === metadata.libraryID && e.itemKey === metadata.itemKey);
    const now = new Date().toISOString();
    if (existing) {
      Object.assign(existing, {
        itemID: metadata.itemID,
        queryText: metadata.queryText,
        queryType: metadata.queryType,
        doi: metadata.doi,
        pmid: metadata.pmid,
        title: metadata.title,
        createdAt: existing.createdAt || now,
        updatedAt: now
      });
      this.save(entries);
      return existing;
    }
    const entry: QueueEntry = {
      itemID: metadata.itemID,
      itemKey: metadata.itemKey,
      libraryID: metadata.libraryID,
      queryText: metadata.queryText,
      queryType: metadata.queryType,
      doi: metadata.doi,
      pmid: metadata.pmid,
      title: metadata.title,
      state: "queued",
      source: null,
      createdAt: now,
      updatedAt: now,
      unmatchedPolls: 0,
      diagnosticLevel: null
    };
    entries.push(entry);
    this.save(entries);
    return entry;
  }

  static patch(itemKey: string, libraryID: number, patch: Partial<QueueEntry>) {
    const entries = this.load();
    const entry = entries.find(e => e.itemKey === itemKey && e.libraryID === libraryID);
    if (!entry) return;
    Object.assign(entry, patch, { updatedAt: new Date().toISOString() });
    this.save(entries);
  }

  static resetForRetry(itemKey: string, libraryID: number) {
    this.patch(itemKey, libraryID, {
      state: "queued",
      source: null,
      error: undefined,
      nativeError: undefined,
      verification: undefined,
      verificationReason: undefined,
      attachmentID: undefined,
      taskUUID: undefined,
      resourceUUID: undefined,
      taskCode: undefined,
      remoteTaskStatus: undefined,
      remoteTaskStatusLabel: undefined,
      remoteCreateTime: undefined,
      matchStrategy: undefined,
      lastMatchedAt: undefined,
      unmatchedPolls: 0,
      firstUnmatchedAt: undefined,
      diagnosticLevel: null,
      diagnosticMessage: undefined,
      submittedAt: undefined,
      lastCheckedAt: undefined,
      nextCheckAt: undefined,
      cancelledAt: undefined,
      cancelNote: undefined,
      retrievalStrategy: undefined
    });
  }

  static cancel(itemKey: string, libraryID: number): boolean {
    const entries = this.load();
    const entry = entries.find(e => e.itemKey === itemKey && e.libraryID === libraryID);
    if (!entry || ["done", "review", "failed", "cancelled"].includes(entry.state)) return false;
    const hadRemoteSubmission = Boolean(entry.submittedAt || entry.taskUUID || entry.taskCode || entry.source === "jlss");
    entry.state = "cancelled";
    entry.cancelledAt = new Date().toISOString();
    entry.cancelNote = hadRemoteSubmission
      ? "已停止 FullTextFlow 本地轮询/下载；若任务此前已提交聚联，聚联远端任务可能仍继续。"
      : "已取消，FullTextFlow 不再继续处理此任务。";
    entry.nextCheckAt = undefined;
    entry.updatedAt = new Date().toISOString();
    this.save(entries);
    return true;
  }

  static cancelAllActive(): number {
    const entries = this.load();
    let count = 0;
    const now = new Date().toISOString();
    for (const entry of entries) {
      if (TERMINAL_STATES.includes(entry.state)) continue;
      const hadRemoteSubmission = Boolean(entry.submittedAt || entry.taskUUID || entry.taskCode || entry.source === "jlss");
      entry.state = "cancelled";
      entry.cancelledAt = now;
      entry.cancelNote = hadRemoteSubmission
        ? "已停止 FullTextFlow 本地轮询/下载；若任务此前已提交聚联，聚联远端任务可能仍继续。"
        : "已取消，FullTextFlow 不再继续处理此任务。";
      entry.nextCheckAt = undefined;
      entry.updatedAt = now;
      count++;
    }
    this.save(entries);
    return count;
  }

  static isCancelled(itemKey: string, libraryID: number): boolean {
    return this.find(itemKey, libraryID)?.state === "cancelled";
  }

  static active(): QueueEntry[] {
    return this.load().filter(e => !TERMINAL_STATES.includes(e.state));
  }

  static clearCompleted() {
    this.save(this.load().filter(e => e.state !== "done"));
  }

  static clearCancelled() {
    this.save(this.load().filter(e => e.state !== "cancelled"));
  }

  static clearFinished() {
    this.save(this.load().filter(e => !["done", "cancelled"].includes(e.state)));
  }

  static countByState() {
    const result: Record<string, number> = {};
    for (const e of this.load()) result[e.state] = (result[e.state] || 0) + 1;
    return result;
  }
}
