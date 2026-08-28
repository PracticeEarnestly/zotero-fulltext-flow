import { TASK_FAILED, TASK_SUCCESS, PREF_PREFIX } from "../config";
import { JLSSClient, JLSSAuthRequiredError } from "./JLSSClient";
import { extractItemMetadata, normalizeQuery, type ItemMetadata } from "./Metadata";
import { PdfImporter } from "./PdfImporter";
import { QueueStore, type QueueEntry } from "./QueueStore";
import { hasUsablePDF } from "./AttachmentDetector";
import { NativeFullText } from "./NativeFullText";
import { PdfVerifier } from "./PdfVerifier";
import { getRetrievalStrategy } from "./RetrievalStrategy";

type RecordMatch = {
  record: any;
  strategy: string;
  score?: number;
};

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
    const strategy = getRetrievalStrategy();
    const nativeFirst = strategy === "zotero_then_jlss" || strategy === "zotero_only";

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
      QueueStore.patch(metadata.itemKey, metadata.libraryID, { retrievalStrategy: strategy });

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

      if (strategy === "zotero_only") {
        QueueStore.patch(metadata.itemKey, metadata.libraryID, {
          state: "failed",
          source: "zotero",
          diagnosticLevel: "info",
          diagnosticMessage: "当前策略为“仅使用 Zotero”；Zotero 未找到全文，因此未向聚联提交。",
          error: "Zotero 内置全文搜索未找到 PDF。可切换获取策略后重试。"
        });
        failed++;
        await this.delay(250);
        continue;
      }

      try {
        if (QueueStore.isCancelled(metadata.itemKey, metadata.libraryID)) continue;
        QueueStore.patch(metadata.itemKey, metadata.libraryID, {
          state: "queued",
          source: "jlss",
          error: undefined,
          unmatchedPolls: 0,
          firstUnmatchedAt: undefined,
          diagnosticLevel: null,
          diagnosticMessage: undefined
        });
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
          diagnosticLevel: "info",
          diagnosticMessage: "已提交聚联，等待远端任务建立。",
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
          const message = e instanceof Error ? e.message : String(e);
          if (strategy === "jlss_then_zotero") {
            const fallbackFound = await this.tryNativeFallback(item, metadata, `聚联提交失败：${message}`);
            if (fallbackFound) { native++; continue; }
          }
          QueueStore.patch(metadata.itemKey, metadata.libraryID, {
            state: "failed",
            source: "jlss",
            error: message
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
      const warnHours = Math.max(1, Number(Zotero.Prefs.get(`${PREF_PREFIX}.pendingWarnHours`) || 24));

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

        const match = this.matchRecord(records, entry);
        if (!match) {
          const unmatchedPolls = Number(entry.unmatchedPolls || 0) + 1;
          const firstUnmatchedAt = entry.firstUnmatchedAt || checkedAt;
          const warning = unmatchedPolls >= 3;
          QueueStore.patch(entry.itemKey, entry.libraryID, {
            state: "pending",
            remoteTaskStatus: "",
            remoteTaskStatusLabel: "尚未在聚联任务列表匹配到记录",
            unmatchedPolls,
            firstUnmatchedAt,
            diagnosticLevel: warning ? "warning" : "info",
            diagnosticMessage: warning
              ? `连续 ${unmatchedPolls} 次未匹配到聚联远端任务。可能是远端任务尚未建立、任务标题被改写，或远端列表结构发生变化。`
              : `第 ${unmatchedPolls} 次尚未匹配到聚联远端任务，继续等待下一次检查。`
          });
          continue;
        }

        const record = match.record;
        const pendingHours = this.hoursSince(entry.submittedAt || entry.createdAt);
        const longRunning = !TASK_FAILED.has(record.taskStatus)
          && record.taskStatus !== TASK_SUCCESS
          && pendingHours >= warnHours;
        const strategyLabel = this.matchStrategyLabel(match.strategy, match.score);

        QueueStore.patch(entry.itemKey, entry.libraryID, {
          taskUUID: record.uuid,
          resourceUUID: record.resourceUuid,
          taskCode: record.taskCode,
          remoteTaskStatus: record.taskStatus,
          remoteTaskStatusLabel: this.remoteStatusLabel(record.taskStatus),
          remoteCreateTime: record.createTime,
          matchStrategy: match.strategy,
          lastMatchedAt: checkedAt,
          unmatchedPolls: 0,
          firstUnmatchedAt: undefined,
          diagnosticLevel: longRunning ? "warning" : "info",
          diagnosticMessage: longRunning
            ? `已通过${strategyLabel}确认远端任务，但聚联已持续处理约 ${Math.floor(pendingHours)} 小时。建议到聚联用户中心核对。`
            : `已通过${strategyLabel}匹配聚联远端任务。`,
          state: record.taskStatus === TASK_SUCCESS ? "downloading" : "pending"
        });

        if (TASK_FAILED.has(record.taskStatus)) {
          if (entry.retrievalStrategy === "jlss_then_zotero") {
            const fallbackFound = await this.tryNativeFallback(
              item,
              entry,
              `聚联远端明确返回失败/异常状态（status=${record.taskStatus}）`
            );
            if (fallbackFound) continue;
          }
          QueueStore.patch(entry.itemKey, entry.libraryID, {
            state: "failed",
            diagnosticLevel: "warning",
            diagnosticMessage: `聚联远端明确返回失败/异常状态（status=${record.taskStatus}）。`,
            error: `聚联任务失败（status=${record.taskStatus}）`
          });
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
            diagnosticLevel: null,
            diagnosticMessage: undefined,
            error: state === "review" ? "PDF 已下载，但身份核验未通过自动阈值，请人工核对。" : undefined
          });
        }
        catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          if (entry.retrievalStrategy === "jlss_then_zotero") {
            const fallbackFound = await this.tryNativeFallback(
              item,
              entry,
              `聚联已返回成功状态，但 PDF 下载或核验失败：${message}`
            );
            if (fallbackFound) continue;
          }
          QueueStore.patch(entry.itemKey, entry.libraryID, {
            state: "failed",
            diagnosticLevel: "warning",
            diagnosticMessage: "聚联已返回成功状态，但 PDF 下载或核验阶段失败。",
            error: message
          });
        }
      }
    }
    finally {
      this.polling = false;
    }
  }

  private async tryNativeFallback(
    item: any,
    entry: { itemKey: string; libraryID: number },
    reason: string
  ): Promise<boolean> {
    QueueStore.patch(entry.itemKey, entry.libraryID, {
      state: "native_search",
      diagnosticLevel: "info",
      diagnosticMessage: `${reason}；正在尝试 Zotero 后补。`
    });

    const nativeResult = await NativeFullText.tryFind(item);
    if (QueueStore.isCancelled(entry.itemKey, entry.libraryID)) {
      if (nativeResult.found && nativeResult.attachmentID) {
        QueueStore.patch(entry.itemKey, entry.libraryID, {
          source: "zotero",
          attachmentID: nativeResult.attachmentID,
          cancelNote: "任务已取消；取消生效前 Zotero 后补已获取全文，现有附件予以保留。"
        });
      }
      return Boolean(nativeResult.found);
    }

    if (!nativeResult.found) {
      QueueStore.patch(entry.itemKey, entry.libraryID, {
        nativeError: nativeResult.error,
        diagnosticLevel: "warning",
        diagnosticMessage: `${reason}；Zotero 后补也未找到全文。`
      });
      return false;
    }

    let verification: any = {
      status: "inconclusive",
      reason: "由 Zotero Find Full Text 后补获取，但未完成二次文本核验。"
    };
    try {
      const attachment: any = nativeResult.attachmentID ? Zotero.Items.get(nativeResult.attachmentID) : null;
      const current = QueueStore.find(entry.itemKey, entry.libraryID);
      if (attachment && current) verification = await PdfVerifier.verify(attachment, current);
    }
    catch (e) {
      verification = {
        status: "inconclusive",
        reason: `Zotero 后补已获取 PDF，但二次核验未完成：${e instanceof Error ? e.message : String(e)}`
      };
    }

    const state = verification.status === "review" ? "review" : "done";
    QueueStore.patch(entry.itemKey, entry.libraryID, {
      state,
      source: "zotero",
      attachmentID: nativeResult.attachmentID,
      verification: verification.status,
      verificationReason: verification.reason,
      nativeError: nativeResult.error,
      diagnosticLevel: state === "review" ? "warning" : null,
      diagnosticMessage: state === "review"
        ? `${reason}；Zotero 后补找到 PDF，但需要人工核对。`
        : `${reason}；Zotero 后补成功。`,
      error: state === "review" ? "Zotero 后补已获取 PDF，但身份核验未通过自动阈值，请人工核对。" : undefined
    });
    return true;
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

  private matchRecord(records: any[], entry: QueueEntry): RecordMatch | null {
    if (entry.taskUUID) {
      const byUUID = records.find(r => String(r.uuid || "") === entry.taskUUID);
      if (byUUID) return { record: byUUID, strategy: "uuid" };
    }
    if (entry.taskCode) {
      const byCode = records.find(r => String(r.taskCode || "") === entry.taskCode);
      if (byCode) return { record: byCode, strategy: "task_code" };
    }

    const exactCandidates = [
      { value: entry.queryText, strategy: "query_exact" },
      { value: entry.doi, strategy: "doi_exact" },
      { value: entry.pmid, strategy: "pmid_exact" },
      { value: entry.title, strategy: "title_exact" }
    ].filter(x => Boolean(normalizeQuery(x.value)));

    for (const candidate of exactCandidates) {
      const normalized = normalizeQuery(candidate.value);
      const found = records.find(r => normalizeQuery(String(r.taskTitle || "")) === normalized);
      if (found) return { record: found, strategy: candidate.strategy };
    }

    const normalizedDOI = normalizeQuery(entry.doi);
    if (normalizedDOI) {
      const byDOI = records.find(r => normalizeQuery(String(r.taskTitle || "")).includes(normalizedDOI));
      if (byDOI) return { record: byDOI, strategy: "doi_contained" };
    }

    if (entry.pmid) {
      const pmid = String(entry.pmid).trim();
      const byPMID = records.find(r => {
        const title = String(r.taskTitle || "");
        return new RegExp(`(^|\\D)${this.escapeRegExp(pmid)}(\\D|$)`).test(title);
      });
      if (byPMID) return { record: byPMID, strategy: "pmid_contained" };
    }

    const targetTokens = this.titleTokens(entry.title);
    if (targetTokens.length < 4) return null;

    const scored = records
      .map(record => ({ record, score: this.titleSimilarity(targetTokens, this.titleTokens(String(record.taskTitle || ""))) }))
      .filter(x => x.score >= 0.72)
      .sort((a, b) => b.score - a.score);

    if (!scored.length) return null;
    const best = scored[0];
    const second = scored[1];
    if (second && best.score < 0.92 && best.score - second.score < 0.08) return null;
    return { record: best.record, strategy: "title_similarity", score: best.score };
  }

  private titleTokens(value: string): string[] {
    const stop = new Set(["the", "and", "for", "with", "from", "that", "this", "into", "using", "study", "analysis", "of", "in", "on", "to", "a", "an"]);
    return Array.from(new Set(
      String(value || "")
        .normalize("NFKC")
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, " ")
        .split(/\s+/)
        .map(x => x.trim())
        .filter(x => x.length >= 3 && !stop.has(x))
    ));
  }

  private titleSimilarity(target: string[], remote: string[]): number {
    if (!target.length || !remote.length) return 0;
    const remoteSet = new Set(remote);
    const intersection = target.filter(x => remoteSet.has(x)).length;
    const coverage = intersection / target.length;
    const union = new Set([...target, ...remote]).size;
    const jaccard = union ? intersection / union : 0;
    return coverage * 0.75 + jaccard * 0.25;
  }

  private matchStrategyLabel(strategy: string, score?: number): string {
    const labels: Record<string, string> = {
      uuid: "UUID",
      task_code: "任务号",
      query_exact: "提交内容精确匹配",
      doi_exact: "DOI 精确匹配",
      pmid_exact: "PMID 精确匹配",
      title_exact: "标题精确匹配",
      doi_contained: "DOI 包含匹配",
      pmid_contained: "PMID 包含匹配",
      title_similarity: "标题相似度匹配"
    };
    const label = labels[strategy] || strategy;
    return score === undefined ? label : `${label}（${Math.round(score * 100)}%）`;
  }

  private hoursSince(value?: string): number {
    if (!value) return 0;
    const time = new Date(value).getTime();
    if (!Number.isFinite(time)) return 0;
    return Math.max(0, (Date.now() - time) / 3_600_000);
  }

  private escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  private prefBool(name: string, fallback: boolean) {
    const value = Zotero.Prefs.get(name);
    return value === undefined || value === null ? fallback : Boolean(value);
  }

  private delay(ms: number) { return new Promise(resolve => setTimeout(resolve, ms)); }
}
