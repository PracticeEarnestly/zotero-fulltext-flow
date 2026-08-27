import type { QueueEntry } from "./QueueStore";

export type VerificationStatus = "verified" | "inconclusive" | "review";

export type VerificationResult = {
  status: VerificationStatus;
  reason: string;
  titleCoverage?: number;
};

const STOPWORDS = new Set([
  "the", "and", "for", "with", "from", "that", "this", "into", "using", "use", "via",
  "study", "analysis", "based", "among", "between", "through", "effects", "effect", "role",
  "novel", "new", "human", "patients", "patient", "disease", "diseases", "cells", "cell"
]);

export class PdfVerifier {
  static async verify(attachment: any, entry: QueueEntry): Promise<VerificationResult> {
    const path = await attachment.getFilePathAsync?.();
    if (!path || !(await IOUtils.exists(path))) {
      throw new Error("下载后未找到本地 PDF 文件。");
    }

    const stat = await IOUtils.stat(path);
    if (Number(stat.size || 0) < 10_000) {
      throw new Error("下载文件过小，未通过 PDF 完整性检查。");
    }

    const head = await IOUtils.read(path, { maxBytes: 5 });
    const signature = String.fromCharCode(...Array.from(head as Uint8Array));
    if (signature !== "%PDF-") {
      throw new Error("下载文件不是有效 PDF。  ");
    }

    const text = await this.extractText(attachment);
    if (!text.trim()) {
      return {
        status: "inconclusive",
        reason: "PDF 完整性通过，但未能提取可用于核验的文本（可能为扫描版或索引尚不可用）。"
      };
    }

    const doi = normalizeDOI(entry.doi || (entry.queryType === "doi" ? entry.queryText : ""));
    if (doi) {
      const compact = text.toLowerCase().replace(/\s+/g, "");
      if (compact.includes(doi.toLowerCase().replace(/\s+/g, ""))) {
        return { status: "verified", reason: "PDF 正文中检测到与 Zotero 条目一致的 DOI。" };
      }
    }

    const coverage = titleCoverage(entry.title || "", text);
    if (coverage >= 0.62) {
      return {
        status: "verified",
        reason: `PDF 标题关键词与 Zotero 条目高度一致（覆盖率 ${(coverage * 100).toFixed(0)}%）。`,
        titleCoverage: coverage
      };
    }

    if (coverage >= 0.35) {
      return {
        status: "inconclusive",
        reason: `未检测到目标 DOI；标题关键词部分一致（覆盖率 ${(coverage * 100).toFixed(0)}%），建议抽查。`,
        titleCoverage: coverage
      };
    }

    return {
      status: "review",
      reason: `未检测到目标 DOI，且标题关键词匹配较低（覆盖率 ${(coverage * 100).toFixed(0)}%），建议人工核对。`,
      titleCoverage: coverage
    };
  }

  private static async extractText(attachment: any): Promise<string> {
    try {
      const fulltext: any = (Zotero as any).Fulltext || (Zotero as any).FullText;
      if (!fulltext?.indexItems || !fulltext?.getItemCacheFile) return "";
      await fulltext.indexItems([attachment.id], { ignoreErrors: true });
      const cache = fulltext.getItemCacheFile(attachment);
      const cachePath = cache?.path;
      if (!cachePath || !(await IOUtils.exists(cachePath))) return "";
      // The title and DOI normally occur early. Limiting the read keeps verification inexpensive.
      const bytes = await IOUtils.read(cachePath, { maxBytes: 120_000 });
      return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    }
    catch (_) {
      return "";
    }
  }
}

function normalizeDOI(value: string): string {
  return String(value || "")
    .trim()
    .replace(/^doi\s*:\s*/i, "")
    .replace(/^https?:\/\/(dx\.)?doi\.org\//i, "")
    .replace(/[\s\]\[(){}<>.,;:]+$/g, "")
    .toLowerCase();
}

function titleCoverage(title: string, text: string): number {
  const target = significantTokens(title);
  if (!target.length) return 0;
  const haystack = normalizeText(text.slice(0, 80_000));
  let matched = 0;
  for (const token of target) {
    if (haystack.includes(` ${token} `) || haystack.startsWith(`${token} `) || haystack.endsWith(` ${token}`)) {
      matched++;
    }
  }
  return matched / target.length;
}

function significantTokens(value: string): string[] {
  const tokens = normalizeText(value)
    .trim()
    .split(/\s+/)
    .filter(t => t.length >= 3 && !STOPWORDS.has(t));
  return Array.from(new Set(tokens)).slice(0, 24);
}

function normalizeText(value: string): string {
  return ` ${String(value || "")
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()} `;
}
