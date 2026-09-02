export type ItemMetadata = {
  itemID: number;
  itemKey: string;
  libraryID: number;
  doi: string;
  pmid: string;
  title: string;
  url: string;
  queryText: string;
  queryType: "doi" | "pmid" | "title" | "url" | null;
};

function field(item: any, name: string): string {
  try { return String(item.getField?.(name) || "").trim(); }
  catch (_) { return ""; }
}

function extractLegacyPMID(extra: string): string {
  const match = String(extra || "").match(/(?:^|\n)\s*PMID\s*:\s*(\d+)/i);
  return match?.[1] || "";
}

export function extractItemMetadata(item: any): ItemMetadata {
  const doi = field(item, "DOI");
  const pmid = field(item, "PMID") || extractLegacyPMID(field(item, "extra"));
  const title = field(item, "title");
  const url = field(item, "url");
  const queryText = doi || pmid || title || url;
  return {
    itemID: Number(item.id),
    itemKey: String(item.key || item.id),
    libraryID: Number(item.libraryID),
    doi,
    pmid,
    title,
    url,
    queryText,
    queryType: doi ? "doi" : pmid ? "pmid" : title ? "title" : url ? "url" : null
  };
}

export function normalizeQuery(value: string): string {
  return String(value || "").trim().toLowerCase().replace(/^https?:\/\/(dx\.)?doi\.org\//, "");
}
