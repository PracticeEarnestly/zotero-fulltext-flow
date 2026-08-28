import { PREF_PREFIX } from "../config";

export type RetrievalStrategy =
  | "jlss_only"
  | "jlss_then_zotero"
  | "zotero_then_jlss"
  | "zotero_only";

export const DEFAULT_RETRIEVAL_STRATEGY: RetrievalStrategy = "jlss_only";

export const RETRIEVAL_STRATEGY_OPTIONS: Array<{ value: RetrievalStrategy; label: string; description: string }> = [
  {
    value: "jlss_only",
    label: "全部使用聚联（默认）",
    description: "跳过 Zotero 内置全文搜索，所有缺少本地 PDF 的文献直接提交聚联。"
  },
  {
    value: "jlss_then_zotero",
    label: "聚联优先 → Zotero 后补",
    description: "先使用聚联；仅在聚联明确失败、提交失败或下载失败时再尝试 Zotero。"
  },
  {
    value: "zotero_then_jlss",
    label: "Zotero 优先 → 聚联后补",
    description: "先使用 Zotero Find Full Text；未找到时再提交聚联。"
  },
  {
    value: "zotero_only",
    label: "仅使用 Zotero",
    description: "只使用 Zotero 内置全文搜索，不向聚联提交任务。"
  }
];

export function getRetrievalStrategy(): RetrievalStrategy {
  const value = String(Zotero.Prefs.get(`${PREF_PREFIX}.retrievalStrategy`) || "").trim() as RetrievalStrategy;
  return RETRIEVAL_STRATEGY_OPTIONS.some(option => option.value === value)
    ? value
    : DEFAULT_RETRIEVAL_STRATEGY;
}

export function setRetrievalStrategy(value: RetrievalStrategy): void {
  if (!RETRIEVAL_STRATEGY_OPTIONS.some(option => option.value === value)) {
    throw new Error(`未知全文获取策略：${value}`);
  }
  Zotero.Prefs.set(`${PREF_PREFIX}.retrievalStrategy`, value);
}

export function retrievalStrategyLabel(value: RetrievalStrategy = getRetrievalStrategy()): string {
  return RETRIEVAL_STRATEGY_OPTIONS.find(option => option.value === value)?.label || value;
}
