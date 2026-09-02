import { PubMedClient, normalizeDOI, type PubMedSummary } from "./PubMedClient";

const TAG_ID_CONFLICT = "pubmed-id-conflict";
const TAG_METADATA_VERIFIED = "pubmed-metadata-verified";
const TAG_METADATA_CONFLICT = "pubmed-metadata-conflict";

export type IdentifierCompletionResult = {
  status: "updated" | "unchanged" | "not_found" | "conflict" | "skipped" | "error";
  pmid: string;
  pmcid: string;
  added: string[];
  message: string;
};

export type MetadataValidationResult = {
  status: "verified" | "conflict" | "no_pubmed" | "skipped" | "error";
  title: string;
  pmid: string;
  differences: string[];
  message: string;
};

export class PubMedQA {
  static async completeIdentifiers(item: any): Promise<IdentifierCompletionResult> {
    if (!item?.isRegularItem?.()) return result("skipped", "", "", [], "Not a regular Zotero item.");

    try {
      const doi = normalizeDOI(field(item, "DOI"));
      const current = extractIdentifiers(item);
      let pmid = current.pmid;
      let pmcid = current.pmcid;
      const added: string[] = [];

      // Automatic matching is deliberately conservative: DOI and an existing PMID are
      // accepted as strong identifiers; title-only searches are never used for auto-write.
      if (doi) {
        const doiPMID = await PubMedClient.findPMIDByDOI(doi);
        if (pmid && doiPMID && pmid !== doiPMID) {
          await setConflictTag(item, true);
          return result("conflict", pmid, pmcid, [], `Existing PMID ${pmid} conflicts with DOI-derived PMID ${doiPMID}.`);
        }
        if (!pmid && doiPMID) {
          pmid = doiPMID;
          added.push("PMID");
        }
      }

      if (!pmid) {
        return result("not_found", "", pmcid, [], doi ? "No unique PubMed PMID was found for the DOI." : "No DOI or PMID is available for safe automatic matching.");
      }

      // PMCID is optional. Absence is normal because many PubMed records are not in PMC.
      const linked = await PubMedClient.resolvePMCIdentifiers(pmid);
      if (linked.pmid && linked.pmid !== pmid) {
        await setConflictTag(item, true);
        return result("conflict", pmid, pmcid, [], `PMID ${pmid} conflicts with the PMC ID-converter result ${linked.pmid}.`);
      }
      if (doi && linked.doi && normalizeDOI(linked.doi) !== doi) {
        await setConflictTag(item, true);
        return result("conflict", pmid, pmcid, [], `DOI ${doi} conflicts with the DOI linked by NCBI (${linked.doi}).`);
      }
      if (pmcid && linked.pmcid && normalizePMCID(pmcid) !== normalizePMCID(linked.pmcid)) {
        await setConflictTag(item, true);
        return result("conflict", pmid, pmcid, [], `Existing PMCID ${pmcid} conflicts with NCBI-linked PMCID ${linked.pmcid}.`);
      }
      if (!pmcid && linked.pmcid) {
        pmcid = normalizePMCID(linked.pmcid);
        added.push("PMCID");
      }

      if (added.length) {
        const extra = appendMissingIdentifiers(field(item, "extra"), pmid, pmcid);
        item.setField("extra", extra);
        await setConflictTag(item, false, false);
        await item.saveTx();
        return result("updated", pmid, pmcid, added, `Added ${added.join(" + ")}.`);
      }

      await setConflictTag(item, false);
      return result("unchanged", pmid, pmcid, [], "PMID/PMCID are already complete or PMCID is not available in PMC.");
    } catch (e) {
      return result("error", "", "", [], e instanceof Error ? e.message : String(e));
    }
  }

  static async validateMetadata(item: any): Promise<MetadataValidationResult> {
    const title = field(item, "title");
    if (!item?.isRegularItem?.()) return validation("skipped", title, "", [], "Not a regular Zotero item.");

    try {
      const idResult = await this.completeIdentifiers(item);
      if (idResult.status === "conflict") {
        await setMetadataTag(item, "conflict");
        return validation("conflict", title, idResult.pmid, [idResult.message], "Identifier conflict; metadata was not changed.");
      }

      const identifiers = extractIdentifiers(item);
      const pmid = identifiers.pmid || idResult.pmid;
      if (!pmid) return validation("no_pubmed", title, "", [], "No PMID is available for PubMed validation.");

      const summary = await PubMedClient.fetchSummary(pmid);
      if (!summary) return validation("no_pubmed", title, pmid, [], "PubMed summary could not be retrieved.");

      const comparison = compareMetadata(item, summary);
      const status = comparison.strongConflict ? "conflict" : "verified";
      await setMetadataTag(item, status);
      return validation(
        status,
        title,
        pmid,
        comparison.differences,
        status === "verified"
          ? "Compared with PubMed; no strong metadata conflict was found. Zotero metadata was not replaced."
          : "Compared with PubMed; a strong conflict was found. Zotero metadata was not replaced."
      );
    } catch (e) {
      return validation("error", title, "", [], e instanceof Error ? e.message : String(e));
    }
  }
}

function result(status: IdentifierCompletionResult["status"], pmid: string, pmcid: string, added: string[], message: string): IdentifierCompletionResult {
  return { status, pmid, pmcid, added, message };
}

function validation(status: MetadataValidationResult["status"], title: string, pmid: string, differences: string[], message: string): MetadataValidationResult {
  return { status, title, pmid, differences, message };
}

function field(item: any, name: string): string {
  return String(item.getField?.(name) || "").trim();
}

function extractIdentifiers(item: any): { pmid: string; pmcid: string } {
  const extra = field(item, "extra");
  const pmid = extra.match(/(?:^|\n)\s*PMID\s*:\s*(\d+)\s*(?:\n|$)/i)?.[1] || "";
  const pmcid = extra.match(/(?:^|\n)\s*PMCID\s*:\s*(PMC\d+)\s*(?:\n|$)/i)?.[1] || "";
  return { pmid, pmcid: normalizePMCID(pmcid) };
}

function appendMissingIdentifiers(extra: string, pmid: string, pmcid: string): string {
  const lines = String(extra || "").replace(/\s+$/g, "").split("\n").filter((x, i, arr) => !(arr.length === 1 && i === 0 && !x));
  const joined = lines.join("\n");
  if (pmid && !/(?:^|\n)\s*PMID\s*:/i.test(joined)) lines.push(`PMID: ${pmid}`);
  if (pmcid && !/(?:^|\n)\s*PMCID\s*:/i.test(joined)) lines.push(`PMCID: ${normalizePMCID(pmcid)}`);
  return lines.join("\n").trim();
}

function normalizePMCID(value: string): string {
  const clean = String(value || "").trim().toUpperCase();
  if (!clean) return "";
  return clean.startsWith("PMC") ? clean : /^\d+$/.test(clean) ? `PMC${clean}` : clean;
}

async function setConflictTag(item: any, conflict: boolean, save = true) {
  const tags = new Set((item.getTags?.() || []).map((x: any) => String(x?.tag || "")));
  let changed = false;
  if (conflict && !tags.has(TAG_ID_CONFLICT)) { item.addTag(TAG_ID_CONFLICT); changed = true; }
  if (!conflict && tags.has(TAG_ID_CONFLICT)) { item.removeTag(TAG_ID_CONFLICT); changed = true; }
  if (changed && save) await item.saveTx();
}

async function setMetadataTag(item: any, status: "verified" | "conflict") {
  const tags = new Set((item.getTags?.() || []).map((x: any) => String(x?.tag || "")));
  let changed = false;
  const add = status === "verified" ? TAG_METADATA_VERIFIED : TAG_METADATA_CONFLICT;
  const remove = status === "verified" ? TAG_METADATA_CONFLICT : TAG_METADATA_VERIFIED;
  if (tags.has(remove)) { item.removeTag(remove); changed = true; }
  if (!tags.has(add)) { item.addTag(add); changed = true; }
  if (changed) await item.saveTx();
}

function compareMetadata(item: any, pubmed: PubMedSummary): { strongConflict: boolean; differences: string[] } {
  const differences: string[] = [];
  let strongConflict = false;
  const push = (name: string, zotero: string, remote: string, strong = false) => {
    differences.push(`${name}: Zotero="${zotero || "∅"}" | PubMed="${remote || "∅"}"`);
    if (strong) strongConflict = true;
  };

  const zTitle = field(item, "title");
  if (zTitle && pubmed.title && titleSimilarity(zTitle, pubmed.title) < 0.88) push("Title", zTitle, pubmed.title, true);

  const zDOI = normalizeDOI(field(item, "DOI"));
  if (zDOI && pubmed.doi && zDOI !== pubmed.doi) push("DOI", zDOI, pubmed.doi, true);

  const zYear = field(item, "date").match(/\b(18|19|20|21)\d{2}\b/)?.[0] || "";
  if (zYear && pubmed.year && zYear !== pubmed.year) push("Year", zYear, pubmed.year, true);

  const zVolume = field(item, "volume");
  if (zVolume && pubmed.volume && normalizeSimple(zVolume) !== normalizeSimple(pubmed.volume)) push("Volume", zVolume, pubmed.volume, true);

  const zIssue = field(item, "issue");
  if (zIssue && pubmed.issue && normalizeSimple(zIssue) !== normalizeSimple(pubmed.issue)) push("Issue", zIssue, pubmed.issue, false);

  const zPages = field(item, "pages");
  if (zPages && pubmed.pages && normalizePages(zPages) !== normalizePages(pubmed.pages)) push("Pages/article number", zPages, pubmed.pages, false);

  const zJournal = field(item, "publicationTitle");
  if (zJournal && pubmed.journal && journalSimilarity(zJournal, pubmed.journal) < 0.75) push("Journal", zJournal, pubmed.journal, false);

  const creators = item.getCreators?.() || [];
  const zFirstAuthor = String(creators.find((x: any) => x?.creatorType === "author")?.lastName || creators[0]?.lastName || "").trim();
  const pFirstAuthor = pubmed.authors[0] ? String(pubmed.authors[0]).trim().split(/\s+/)[0] : "";
  if (zFirstAuthor && pFirstAuthor && normalizeSimple(zFirstAuthor) !== normalizeSimple(pFirstAuthor)) push("First author", zFirstAuthor, pFirstAuthor, false);

  return { strongConflict, differences };
}

function normalizeSimple(value: string): string {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function normalizePages(value: string): string {
  return String(value || "").toLowerCase().replace(/[–—−]/g, "-").replace(/\s+/g, "").replace(/^e(?=\d)/, "");
}

function titleSimilarity(a: string, b: string): number {
  const aa = tokens(a);
  const bb = tokens(b);
  if (!aa.size || !bb.size) return 0;
  let intersect = 0;
  for (const t of aa) if (bb.has(t)) intersect++;
  return (2 * intersect) / (aa.size + bb.size);
}

function journalSimilarity(a: string, b: string): number {
  const clean = (x: string) => String(x || "").toLowerCase().replace(/\([^)]*\)/g, " ").replace(/\bthe\b/g, " ");
  return titleSimilarity(clean(a), clean(b));
}

function tokens(value: string): Set<string> {
  return new Set(
    String(value || "")
      .toLowerCase()
      .replace(/<[^>]+>/g, " ")
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .trim()
      .split(/\s+/)
      .filter(Boolean)
  );
}
