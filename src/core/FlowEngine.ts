import { TASK_FAILED, TASK_SUCCESS, PREF_PREFIX } from "../config";
import { JLSSClient, JLSSAuthRequiredError } from "./JLSSClient";
import { extractItemMetadata, normalizeQuery, type ItemMetadata } from "./Metadata";
import { PdfImporter } from "./PdfImporter";
import { QueueStore, type QueueEntry } from "./QueueStore";
import { hasUsablePDF } from "./AttachmentDetector";
import { NativeFullText } from "./NativeFullText";
import { PdfVerifier } from "./PdfVerifier";

export class FlowEngine {
  private timer: any = null;
  private polling = false;
  private cancelGeneration = 0;

  start() {
    this.stop();
    const minutes = Math.max(1, Number(Zotero.Prefs.get(`${PREF_PREFIX}.pollMinutes`) || 5));
    this.timer = setInterval(() => this.poll().catch(e => Zotero.debug(`FullTextFlow poll error: ${e}`)), minutes * 60_000);
    setTimeout(() => this.poll().catch(() => {}), 15_000);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async enqueueMetadata(list: ItemMetadata[]): Promise<{queued: number; native: number; skipped: number; failed: number; waitingAuth: number}> {
    let queued = 0, native = 0, skipped = 0, failed = 0, waitingAuth = 0;
    const generation = this.cancelGeneration;
    const maxBatch = Math.max(1, Number(Zotero.Prefs.get(`${PREF_PREFIX}.maxBatch`) || 50));
    const nativeFirst = this.prefBool(`${PREF_PREFIX}.nativeFirst`, true);

    for (const metadata of list.slice(0, maxBatch)) {
      if (generation !== this.cancelGeneration) break;
      const item: any = Zotero.Items.get(metadata.itemID);
      if (!item || await hasUsablePDF(item)) { skipped++; continue; }

      const existing = QueueStore.load().find(e => e.libraryID === metadata.libraryID && e.itemKey === metadata.itemKey);
      if (existing && !["failed", "review", "done", "cancelled"].includes(existing.state)) { skipped++; continue; }
      if (existing && ["done", "cancelled"].includes(existing.state) && !(await hasUsablePDF(item))) {
        QueueStore.resetForRetry(metadata.itemKey, metadata.libraryID);
      }

      QueueStore.upsert(metadata);

      if (nativeFirst) {
        QueueStore.patch(metadata.itemKey, metadata.libraryID, { state: "native_search", source: null, error: undefined });
        const nativeResult = await NativeFullText.tryFind(item);
        if (QueueStore.isCancelled(metadata.itemKey, metadata.libraryID)) {
          if (nativeResult.found && nativeResult.attachmentID) {
            QueueStore.patch(metadata.itemKey, metadata.libraryID, {
              source: "zotero",
              attachmentID: nativeResult.attachmentID,
              cancelNote: "任务已取消；取消生效前 Zotero 已完成全文获取，现有附件予以保留。"
            });
          }
          continue;
        }
        if (nativeResult.found) {
          let verification: any = {
            status: "inconclusive",
            reason: "由 Zotero Find Full Text 能力获取，但未完成二次文本核验。"
          };
          try {
            const attachment: any = nativeResult.attachmentID ? Zotero.Items.get(nativeResult.attachmentID) : null;
            const entry = QueueStore.load().find(e => e.libraryID === metadata.libraryID && e.itemKey === metadata.itemKey);
            if (attachment && entry) verification = await PdfVerifier.verify(attachment, entry);
          }
          catch (e) {
            verification = {
              status: "inconclusive",
              reason: `Zotero 已获取 PDF，但二次核验未完成：${e instanceof Error ? e.message : String(e)}`
            };
          }
          const nativeState = verification.status === "review" ? "review" : "done";
          QueueStore.patch(metadata.itemKey, metadata.libraryID, {
            state: nativeState,
            source: "zotero",
            attachmentID: nativeResult.attachmentID,
            verification: verification.status,
            verificationReason: verification.reason,
            nativeError: nativeResult.error,
            error: nativeState === "review" ? "Zotero 已获取 PDF，但身份核验未通过自动阈值，请人工核对。" : undefined
          });
          native++;
          await this.delay(250);
          continue;
        }
        if (nativeResult.error) {
          QueueStore.patch(metadata.itemKey, metadata.libraryID, { nativeError: nativeResult.error });
        }
      }

      try {
        if (QueueStore.isCancelled(metadata.itemKey, metadata.libraryID)) continue;
        QueueStore.patch(metadata.itemKey, metadata.libraryID, { state: "queued", source: "jlss", error: undefined });
        await JLSSClient.submit(metadata);
        if (QueueStore.isCancelled(metadata.itemKey, metadata.libraryID)) {
          QueueStore.patch(metadata.itemKey, metadata.libraryID, {
            source: "jlss",
            submittedAt: new Date().toISOString(),
            cancelNote: "任务已取消；取消生效前请求已提交聚联，远端任务可能仍继续，但 FullTextFlow 不再轮询或下载。"
          });
          continue;
        }
        QueueStore.patch(metadata.itemKey, metadata.libraryID, {
          state: "submitted",
          source: "jlss",
          submittedAt: new Date().toISOString(),
          nextCheckAt: new Date(Date.now() + 8000).toISOString(),
          error: undefined
        });
        queued++;
        await this.delay(650);
      }
      catch (e) {
        if (e instanceof JLSSAuthRequiredError) {
          QueueStore.patch(metadata.itemKey, metadata.libraryID, {
            state: "waiting_auth",
            source: "jlss",
            error: e.message
          });
          waitingAuth++;
        }
        else {
          QueueStore.patch(metadata.itemKey, metadata.libraryID, {
            state: "failed",
            source: "jlss",
            error: e instanceof Error ? e.message : String(e)
          });
          failed++;
        }
      }
    }
    setTimeout(() => this.poll().catch(() => {}), 8000);
    return { queued, native, skipped, failed, waitingAuth };
  }

  async enqueueItems(items: any[]) {
    const list: ItemMetadata[] = [];
    for (const item of items) {
      if (!item?.isRegularItem?.()) continue;
      if (await hasUsablePDF(item)) continue;
      const md = extractItemMetadata(item);
      if (md.queryText) list.push(md);
    }
    return this.enqueueMetadata(list);
  }

  async retryProblemEntries(): Promise<{queued: number; native: number; skipped: number; failed: number; waitingAuth: number}> {
    const problem = QueueStore.load().filter(e => ["failed", "review", "waiting_auth"].includes(e.state));
    const list: ItemMetadata[] = [];
    for (const entry of problem) {
      const item: any = Zotero.Items.get(entry.itemID);
      if (!item?.isRegularItem?.()) continue;

      if (entry.state === "review" && entry.attachmentID) {
        const attachment: any = Zotero.Items.get(entry.attachmentID);
        if (attachment) {
          try {
            const verification = await PdfVerifier.verify(attachment, entry);
            QueueStore.patch(entry.itemKey, entry.libraryID, {
              state: verification.status === "review" ? "review" : "done",
              verification: verification.status,
              verificationReason: verification.reason,
              error: verification.status === "review" ? entry.error : undefined
            });
            if (verification.status !== "review") continue;
          }
          catch (_) {
            // Fall through. If the attachment has disappeared, a normal retry can fetch again.
          }
        }
      }

      if (await hasUsablePDF(item)) continue;
      QueueStore.resetForRetry(entry.itemKey, entry.libraryID);
      list.push(extractItemMetadata(item));
    }
    return this.enqueueMetadata(list);
  }

  async resumeAuthWaiting(): Promise<{queued: number; native: number; skipped: number; failed: number; waitingAuth: number}> {
    const waiting = QueueStore.load().filter(e => e.state === "waiting_auth");
    const list: ItemMetadata[] = [];
    for (const entry of waiting) {
      const item: any = Zotero.Items.get(entry.itemID);
      if (!item?.isRegularItem?.() || await hasUsablePDF(item)) continue;
      QueueStore.resetForRetry(entry.itemKey, entry.libraryID);
      const md = extractItemMetadata(item);
      if (md.queryText) list.push(md);
    }
    if (!list.length) return { queued: 0, native: 0, skipped: 0, failed: 0, waitingAuth: 0 };
    return this.enqueueMetadata(list);
  }

  async poll() {
    if (this.polling) return;
    const active = QueueStore.active().filter(e => e.source === "jlss" || ["submitted", "pending", "downloading"].includes(e.state));
    if (!active.length) return;
    this.polling = true;
    try {
      let records: any[];
      try {
        records = await JLSSClient.listAllTasks();
      }
      catch (e) {
        if (e instanceof JLSSAuthRequiredError) {
          for (const entry of active) {
            QueueStore.patch(entry.itemKey, entry.libraryID, { state: "waiting_auth", source: "jlss", error: e.message });
          }
          return;
        }
        throw e;
      }
      const checkedAt = new Date().toISOString();
      const minutes = Math.max(1, Number(Zotero.Prefs.get(`${PREF_PREFIX}.pollMinutes`) || 5));
      const nextCheckAt = new Date(Date.now() + minutes * 60_000).toISOString();
      for (const entry of active) {
        if (QueueStore.isCancelled(entry.itemKey, entry.libraryID)) continue;
        QueueStore.patch(entry.itemKey, entry.libraryID, { lastCheckedAt: checkedAt, nextCheckAt });
        const item: any = Zotero.Items.get(entry.itemID);
        if (!item) {
          QueueStore.patch(entry.itemKey, entry.libraryID, { state: "failed", error: "Zotero 条目已不存在。" });
          continue;
        }
        if (await hasUsablePDF(item)) {
          QueueStore.patch(entry.itemKey, entry.libraryID, { state: "done", error: undefined });
          continue;
        }

        const record = this.matchRecord(records, entry);
        if (!record) {
          QueueStore.patch(entry.itemKey, entry.libraryID, {
            state: "pending",
            remoteTaskStatus: "",
            remoteTaskStatusLabel: "尚未在聚联任务列表匹配到记录"
          });
          continue;
        }

        QueueStore.patch(entry.itemKey, entry.libraryID, {
          taskUUID: record.uuid,
          resourceUUID: record.resourceUuid,
          taskCode: record.taskCode,
          remoteTaskStatus: record.taskStatus,
          remoteTaskStatusLabel: this.remoteStatusLabel(record.taskStatus),
          remoteCreateTime: record.createTime,
          state: record.taskStatus === TASK_SUCCESS ? "downloading" : "pending"
        });

        if (TASK_FAILED.has(record.taskStatus)) {
          QueueStore.patch(entry.itemKey, entry.libraryID, { state: "failed", error: `聚联任务失败（status=${record.taskStatus}）` });
          continue;
        }
        if (record.taskStatus !== TASK_SUCCESS) continue;

        try {
          if (QueueStore.isCancelled(entry.itemKey, entry.libraryID)) continue;
          const url = await JLSSClient.getDownloadURL(record);
          if (QueueStore.isCancelled(entry.itemKey, entry.libraryID)) continue;
          const result = await PdfImporter.importFromURL(item, entry, url);
          if (QueueStore.isCancelled(entry.itemKey, entry.libraryID)) {
            QueueStore.patch(entry.itemKey, entry.libraryID, {
              attachmentID: Number(result.attachment?.id || 0) || undefined,
              verification: result.verification.status,
              verificationReason: result.verification.reason,
              cancelNote: "任务已取消；取消生效前 PDF 下载已完成，附件予以保留。"
            });
            continue;
          }
          const state = result.verification.status === "review" ? "review" : "done";
          QueueStore.patch(entry.itemKey, entry.libraryID, {
            state,
            source: "jlss",
            attachmentID: Number(result.attachment?.id || 0) || undefined,
            verification: result.verification.status,
            verificationReason: result.verification.reason,
            error: state === "review" ? "PDF 已下载，但身份核验未通过自动阈值，请人工核对。" : undefined
          });
        }
        catch (e) {
          QueueStore.patch(entry.itemKey, entry.libraryID, { state: "failed", error: e instanceof Error ? e.message : String(e) });
        }
      }
    }
    finally {
      this.polling = false;
    }
  }

  cancelEntry(itemKey: string, libraryID: number): boolean {
    return QueueStore.cancel(itemKey, libraryID);
  }

  cancelAllActive(): number {
    this.cancelGeneration++;
    return QueueStore.cancelAllActive();
  }

  private remoteStatusLabel(status: string): string {
    if (status === TASK_SUCCESS) return "成功，可下载";
    if (status === "3") return "失败";
    if (status === "6") return "报错/异常";
    if (!status) return "等待聚联返回状态";
    return `人工查找/处理中（status=${status}）`;
  }

  private matchRecord(records: any[], entry: QueueEntry) {
    // Prefer persisted UUID/task code when known. Fall back to normalized task title.
    if (entry.taskUUID) {
      const byUUID = records.find(r => r.uuid === entry.taskUUID);
      if (byUUID) return byUUID;
    }
    if (entry.taskCode) {
      const byCode = records.find(r => r.taskCode === entry.taskCode);
      if (byCode) return byCode;
    }
    const q = normalizeQuery(entry.queryText);
    return records.find(r => normalizeQuery(r.taskTitle) === q) || null;
  }

  private prefBool(name: string, fallback: boolean) {
    const value = Zotero.Prefs.get(name);
    return value === undefined || value === null ? fallback : Boolean(value);
  }

  private delay(ms: number) { return new Promise(resolve => setTimeout(resolve, ms)); }
}
