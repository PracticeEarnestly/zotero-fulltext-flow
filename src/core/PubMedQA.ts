import { PubMedClient, normalizePubMedDOI, type PubMedSummary } from "./PubMedClient";

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

type IdentifierState = {
  pmid: string;
  pmcid: string;
  nativePMID: string;
  nativePMCID: string;
  legacyPMID: string;
  legacyPMCID: string;
};

export class PubMedQA {
  static async completeIdentifiers(item: any): Promise<IdentifierCompletionResult> {
    if (!item?.isRegularItem?.()) return result("skipped", "", "", [], "Not a regular Zotero item.");
    if (!supportsNativeIdentifierFields(item)) {
      return result("skipped", "", "", [], "This Zotero item type/version does not support native PMID/PMCID fields.");
    }

    try {
      const doi = normalizePubMedDOI(pubMedField(item, "DOI"));
      const current = extractIdentifiers(item);

      if (current.nativePMID && current.legacyPMID && current.nativePMID !== current.legacyPMID) {
        await setConflictTag(item, true);
        return result("conflict", current.nativePMID, current.nativePMCID, [], `Native PMID ${current.nativePMID} conflicts with legacy Extra PMID ${current.legacyPMID}.`);
      }
      if (current.nativePMCID && current.legacyPMCID && normalizePMCID(current.nativePMCID) !== normalizePMCID(current.legacyPMCID)) {
        await setConflictTag(item, true);
        return result("conflict", current.nativePMID, current.nativePMCID, [], `Native PMCID ${current.nativePMCID} conflicts with legacy Extra PMCID ${current.legacyPMCID}.`);
      }

      let pmid = current.pmid;
      let pmcid = current.pmcid;

      // Automatic matching is deliberately conservative: DOI and an existing PMID are
      // accepted as strong identifiers; title-only searches are never used for auto-write.
      if (doi) {
        const doiPMID = await PubMedClient.findPMIDByDOI(doi);
        if (pmid && doiPMID && pmid !== doiPMID) {
          await setConflictTag(item, true);
          return result("conflict", pmid, pmcid, [], `Existing PMID ${pmid} conflicts with DOI-derived PMID ${doiPMID}.`);
        }
        if (!pmid && doiPMID) pmid = doiPMID;
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
      if (doi && linked.doi && normalizePubMedDOI(linked.doi) !== doi) {
        await setConflictTag(item, true);
        return result("conflict", pmid, pmcid, [], `DOI ${doi} conflicts with the DOI linked by NCBI (${linked.doi}).`);
      }
      if (pmcid && linked.pmcid && normalizePMCID(pmcid) !== normalizePMCID(linked.pmcid)) {
        await setConflictTag(item, true);
        return result("conflict", pmid, pmcid, [], `Existing PMCID ${pmcid} conflicts with NCBI-linked PMCID ${linked.pmcid}.`);
      }
      if (!pmcid && linked.pmcid) pmcid = normalizePMCID(linked.pmcid);

      const added: string[] = [];
      let changed = false;
      if (pmid && !current.nativePMID) {
        item.setField("PMID", pmid);
        added.push("PMID");
        changed = true;
      }
      if (pmcid && !current.nativePMCID) {
        item.setField("PMCID", normalizePMCID(pmcid));
        added.push("PMCID");
        changed = true;
      }

      // Zotero now has proper PMID/PMCID fields. If identical legacy lines remain in
      // Extra, remove only those exact identifier lines while preserving all other Extra data.
      const extra = pubMedField(item, "extra");
      const cleanedExtra = removeMatchingLegacyIdentifiers(extra, pmid, pmcid);
      if (cleanedExtra !== extra) {
        item.setField("extra", cleanedExtra);
        changed = true;
      }

      await setConflictTag(item, false, false);
      if (changed) {
        await item.saveTx();
        return result("updated", pmid, pmcid, added, added.length ? `Stored ${added.join(" + ")} in Zotero native fields.` : "Migrated matching legacy PMID/PMCID lines out of Extra.");
      }

      return result("unchanged", pmid, pmcid, [], "Native PMID/PMCID fields are already complete or PMCID is not available in PMC.");
    } catch (e) {
      return result("error", "", "", [], e instanceof Error ? e.message : String(e));
    }
  }

  static async validateMetadata(item: any): Promise<MetadataValidationResult> {
    const title = pubMedField(item, "title");
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

function pubMedField(item: any, name: string): string {
  try { return String(item.getField?.(name) || "").trim(); }
  catch (_) { return ""; }
}

function supportsNativeIdentifierFields(item: any): boolean {
  try {
    const pmidID = Zotero.ItemFields?.getID?.("PMID");
    const pmcidID = Zotero.ItemFields?.getID?.("PMCID");
    if (!pmidID || !pmcidID) return false;
    return Boolean(
      Zotero.ItemFields?.isValidForType?.(pmidID, item.itemTypeID)
      && Zotero.ItemFields?.isValidForType?.(pmcidID, item.itemTypeID)
    );
  } catch (_) {
    return false;
  }
}

function extractIdentifiers(item: any): IdentifierState {
  const nativePMID = pubMedField(item, "PMID");
  const nativePMCID = normalizePMCID(pubMedField(item, "PMCID"));
  const extra = pubMedField(item, "extra");
  const legacyPMID = extra.match(/(?:^|\n)\s*PMID\s*:\s*(\d+)\s*(?:\n|$)/i)?.[1] || "";
  const legacyPMCID = normalizePMCID(extra.match(/(?:^|\n)\s*PMCID\s*:\s*(PMC\d+)\s*(?:\n|$)/i)?.[1] || "");
  return {
    pmid: nativePMID || legacyPMID,
    pmcid: nativePMCID || legacyPMCID,
    nativePMID,
    nativePMCID,
    legacyPMID,
    legacyPMCID
  };
}

function removeMatchingLegacyIdentifiers(extra: string, pmid: string, pmcid: string): string {
  const wantedPMID = String(pmid || "").trim();
  const wantedPMCID = normalizePMCID(pmcid);
  return String(extra || "")
    .split("\n")
    .filter(line => {
      const p = line.match(/^\s*PMID\s*:\s*(\d+)\s*$/i)?.[1] || "";
      if (p && wantedPMID && p === wantedPMID) return false;
      const pc = normalizePMCID(line.match(/^\s*PMCID\s*:\s*(PMC\d+)\s*$/i)?.[1] || "");
      if (pc && wantedPMCID && pc === wantedPMCID) return false;
      return true;
    })
    .join("\n")
    .replace(/^\n+|\n+$/g, "");
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

  const zTitle = pubMedField(item, "title");
  if (zTitle && pubmed.title && titleSimilarity(zTitle, pubmed.title) < 0.88) push("Title", zTitle, pubmed.title, true);

  const zDOI = normalizePubMedDOI(pubMedField(item, "DOI"));
  if (zDOI && pubmed.doi && zDOI !== pubmed.doi) push("DOI", zDOI, pubmed.doi, true);

  const zYear = pubMedField(item, "date").match(/\b(18|19|20|21)\d{2}\b/)?.[0] || "";
  if (zYear && pubmed.year && zYear !== pubmed.year) push("Year", zYear, pubmed.year, true);

  const zVolume = pubMedField(item, "volume");
  if (zVolume && pubmed.volume && normalizeSimple(zVolume) !== normalizeSimple(pubmed.volume)) push("Volume", zVolume, pubmed.volume, true);

  const zIssue = pubMedField(item, "issue");
  if (zIssue && pubmed.issue && normalizeSimple(zIssue) !== normalizeSimple(pubmed.issue)) push("Issue", zIssue, pubmed.issue, false);

  const zPages = pubMedField(item, "pages");
  if (zPages && pubmed.pages && normalizePages(zPages) !== normalizePages(pubmed.pages)) push("Pages/article number", zPages, pubmed.pages, false);

  const zJournal = pubMedField(item, "publicationTitle");
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
