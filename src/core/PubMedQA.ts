import { PubMedClient, normalizePubMedDOI, type PubMedSummary, type PubMedAuthor } from "./PubMedClient";

const TAG_ID_CONFLICT = "pubmed-id-conflict";
const TAG_METADATA_VERIFIED = "pubmed-metadata-verified";
const TAG_METADATA_CONFLICT = "pubmed-metadata-conflict";
const TAG_METADATA_UPDATED = "pubmed-metadata-updated";

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

export type MetadataFieldChange = {
  field: string;
  label: string;
  from: string;
  to: string;
};

export type MetadataReplacementPreview = {
  status: "ready" | "unchanged" | "conflict" | "no_pubmed" | "skipped" | "error";
  title: string;
  pmid: string;
  changes: MetadataFieldChange[];
  summary: PubMedSummary | null;
  message: string;
};

export type MetadataReplacementResult = {
  status: "updated" | "unchanged" | "error";
  changedFields: string[];
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

  static async prepareMetadataReplacement(item: any): Promise<MetadataReplacementPreview> {
    const title = pubMedField(item, "title");
    if (!item?.isRegularItem?.()) return replacementPreview("skipped", title, "", [], null, "Not a regular Zotero item.");
    try {
      const idResult = await this.completeIdentifiers(item);
      if (idResult.status === "conflict") {
        return replacementPreview("conflict", title, idResult.pmid, [], null, idResult.message);
      }
      const pmid = extractIdentifiers(item).pmid || idResult.pmid;
      if (!pmid) return replacementPreview("no_pubmed", title, "", [], null, "No PMID is available for PubMed metadata replacement.");
      const summary = await PubMedClient.fetchSummary(pmid);
      if (!summary) return replacementPreview("no_pubmed", title, pmid, [], null, "PubMed metadata could not be retrieved.");
      const changes = buildReplacementChanges(item, summary);
      return replacementPreview(changes.length ? "ready" : "unchanged", title, pmid, changes, summary, changes.length ? "Review the differences before applying." : "Zotero metadata already matches the PubMed record.");
    } catch (e) {
      return replacementPreview("error", title, "", [], null, e instanceof Error ? e.message : String(e));
    }
  }

  static async applyMetadataReplacement(item: any, preview: MetadataReplacementPreview, includeAuthors: boolean): Promise<MetadataReplacementResult> {
    if (preview.status !== "ready" || !preview.summary) return { status: "unchanged", changedFields: [], message: "No metadata replacement is ready." };
    try {
      const changedFields: string[] = [];
      for (const change of preview.changes) {
        if (change.field === "creators") continue;
        if (!isFieldValidForItem(item, change.field)) continue;
        item.setField(change.field, change.to);
        changedFields.push(change.label);
      }

      const authorChange = preview.changes.find(x => x.field === "creators");
      if (includeAuthors && authorChange && preview.summary.structuredAuthors.length) {
        const existing = item.getCreators?.() || [];
        const nonAuthors = existing.filter((creator: any) => !isAuthorCreator(creator));
        item.setCreators([...pubMedCreators(preview.summary.structuredAuthors), ...nonAuthors]);
        changedFields.push("Authors");
      }

      if (!changedFields.length) return { status: "unchanged", changedFields: [], message: "No selected PubMed fields required replacement." };
      await markMetadataUpdated(item);
      await item.saveTx();
      return { status: "updated", changedFields, message: `Replaced ${changedFields.join(", ")} from PubMed after confirmation.` };
    } catch (e) {
      return { status: "error", changedFields: [], message: e instanceof Error ? e.message : String(e) };
    }
  }
}

function result(status: IdentifierCompletionResult["status"], pmid: string, pmcid: string, added: string[], message: string): IdentifierCompletionResult {
  return { status, pmid, pmcid, added, message };
}

function validation(status: MetadataValidationResult["status"], title: string, pmid: string, differences: string[], message: string): MetadataValidationResult {
  return { status, title, pmid, differences, message };
}

function replacementPreview(status: MetadataReplacementPreview["status"], title: string, pmid: string, changes: MetadataFieldChange[], summary: PubMedSummary | null, message: string): MetadataReplacementPreview {
  return { status, title, pmid, changes, summary, message };
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
    return Boolean(Zotero.ItemFields?.isValidForType?.(pmidID, item.itemTypeID) && Zotero.ItemFields?.isValidForType?.(pmcidID, item.itemTypeID));
  } catch (_) { return false; }
}

function isFieldValidForItem(item: any, field: string): boolean {
  try {
    const id = Zotero.ItemFields?.getID?.(field);
    return Boolean(id && Zotero.ItemFields?.isValidForType?.(id, item.itemTypeID));
  } catch (_) { return false; }
}

function extractIdentifiers(item: any): IdentifierState {
  const nativePMID = pubMedField(item, "PMID");
  const nativePMCID = normalizePMCID(pubMedField(item, "PMCID"));
  const extra = pubMedField(item, "extra");
  const legacyPMID = extra.match(/(?:^|\n)\s*PMID\s*:\s*(\d+)\s*(?:\n|$)/i)?.[1] || "";
  const legacyPMCID = normalizePMCID(extra.match(/(?:^|\n)\s*PMCID\s*:\s*(PMC\d+)\s*(?:\n|$)/i)?.[1] || "");
  return { pmid: nativePMID || legacyPMID, pmcid: nativePMCID || legacyPMCID, nativePMID, nativePMCID, legacyPMID, legacyPMCID };
}

function removeMatchingLegacyIdentifiers(extra: string, pmid: string, pmcid: string): string {
  const wantedPMID = String(pmid || "").trim();
  const wantedPMCID = normalizePMCID(pmcid);
  return String(extra || "").split("\n").filter(line => {
    const p = line.match(/^\s*PMID\s*:\s*(\d+)\s*$/i)?.[1] || "";
    if (p && wantedPMID && p === wantedPMID) return false;
    const pc = normalizePMCID(line.match(/^\s*PMCID\s*:\s*(PMC\d+)\s*$/i)?.[1] || "");
    if (pc && wantedPMCID && pc === wantedPMCID) return false;
    return true;
  }).join("\n").replace(/^\n+|\n+$/g, "");
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

async function markMetadataUpdated(item: any) {
  const tags = new Set((item.getTags?.() || []).map((x: any) => String(x?.tag || "")));
  if (!tags.has(TAG_METADATA_UPDATED)) item.addTag(TAG_METADATA_UPDATED);
  if (tags.has(TAG_METADATA_VERIFIED)) item.removeTag(TAG_METADATA_VERIFIED);
  if (tags.has(TAG_METADATA_CONFLICT)) item.removeTag(TAG_METADATA_CONFLICT);
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
  const zFirstAuthor = String(creators.find((x: any) => isAuthorCreator(x))?.lastName || creators[0]?.lastName || "").trim();
  const pFirstAuthor = pubmed.structuredAuthors[0]?.lastName || pubmed.structuredAuthors[0]?.collectiveName || (pubmed.authors[0] ? String(pubmed.authors[0]).trim().split(/\s+/)[0] : "");
  if (zFirstAuthor && pFirstAuthor && normalizeSimple(zFirstAuthor) !== normalizeSimple(pFirstAuthor)) push("First author", zFirstAuthor, pFirstAuthor, false);
  return { strongConflict, differences };
}

function buildReplacementChanges(item: any, pubmed: PubMedSummary): MetadataFieldChange[] {
  const changes: MetadataFieldChange[] = [];
  addFieldChange(changes, item, "title", "Title", pubmed.title, valuesDiffer);
  addFieldChange(changes, item, "publicationTitle", "Journal", pubmed.journal, valuesDiffer);
  addFieldChange(changes, item, "journalAbbreviation", "Journal abbreviation", pubmed.journalAbbr, valuesDiffer);
  const currentDate = pubMedField(item, "date");
  if (pubmed.pubDate && shouldReplaceDate(currentDate, pubmed.pubDate, pubmed.year) && isFieldValidForItem(item, "date")) {
    changes.push({ field: "date", label: "Date", from: currentDate, to: pubmed.pubDate });
  }
  addFieldChange(changes, item, "volume", "Volume", pubmed.volume, valuesDiffer);
  addFieldChange(changes, item, "issue", "Issue", pubmed.issue, valuesDiffer);
  addFieldChange(changes, item, "pages", "Pages/article number", pubmed.pages, pagesDiffer);
  addFieldChange(changes, item, "DOI", "DOI", pubmed.doi, doiDiffer);

  if (pubmed.structuredAuthors.length) {
    const currentAuthors = (item.getCreators?.() || []).filter((x: any) => isAuthorCreator(x));
    if (authorSignatureFromZotero(currentAuthors) !== authorSignatureFromPubMed(pubmed.structuredAuthors)) {
      changes.push({ field: "creators", label: "Authors", from: formatZoteroAuthors(currentAuthors), to: formatPubMedAuthors(pubmed.structuredAuthors) });
    }
  }
  return changes;
}

function addFieldChange(changes: MetadataFieldChange[], item: any, field: string, label: string, remote: string, differs: (a: string, b: string) => boolean) {
  const to = String(remote || "").trim();
  if (!to || !isFieldValidForItem(item, field)) return;
  const from = pubMedField(item, field);
  if (differs(from, to)) changes.push({ field, label, from, to });
}

function valuesDiffer(a: string, b: string): boolean { return normalizeTextValue(a) !== normalizeTextValue(b); }
function pagesDiffer(a: string, b: string): boolean { return normalizePages(a) !== normalizePages(b); }
function doiDiffer(a: string, b: string): boolean { return normalizePubMedDOI(a) !== normalizePubMedDOI(b); }

function shouldReplaceDate(current: string, remote: string, remoteYear: string): boolean {
  if (!remote) return false;
  if (!current) return true;
  const currentYear = current.match(/\b(18|19|20|21)\d{2}\b/)?.[0] || "";
  if (currentYear && remoteYear && currentYear !== remoteYear) return true;
  if (/^\d{4}$/.test(current.trim()) && remote.trim().length > 4) return true;
  return false;
}

function isAuthorCreator(creator: any): boolean {
  try {
    if (String(creator?.creatorType || "").toLowerCase() === "author") return true;
    const authorID = Zotero.CreatorTypes?.getID?.("author");
    return Boolean(authorID && Number(creator?.creatorTypeID) === Number(authorID));
  } catch (_) { return false; }
}

function pubMedCreators(authors: PubMedAuthor[]): any[] {
  return authors.map(author => author.collectiveName
    ? { creatorType: "author", firstName: "", lastName: author.collectiveName, fieldMode: 1 }
    : { creatorType: "author", firstName: author.firstName || author.initials || "", lastName: author.lastName, fieldMode: 0 }
  );
}

function authorSignatureFromZotero(authors: any[]): string {
  return authors.map(a => {
    const last = normalizeSimple(String(a?.lastName || ""));
    if (Number(a?.fieldMode) === 1) return `group:${last}`;
    const initials = String(a?.firstName || "").split(/\s+/).filter(Boolean).map((x: string) => x[0] || "").join("").toLowerCase();
    return `${last}:${initials}`;
  }).join("|");
}

function authorSignatureFromPubMed(authors: PubMedAuthor[]): string {
  return authors.map(a => a.collectiveName
    ? `group:${normalizeSimple(a.collectiveName)}`
    : `${normalizeSimple(a.lastName)}:${normalizeSimple(a.initials || initialsFromName(a.firstName))}`
  ).join("|");
}

function initialsFromName(value: string): string { return String(value || "").split(/\s+/).filter(Boolean).map(x => x[0] || "").join(""); }
function formatZoteroAuthors(authors: any[]): string { return authors.map(a => Number(a?.fieldMode) === 1 ? String(a?.lastName || "") : `${a?.lastName || ""} ${a?.firstName || ""}`.trim()).join("; "); }
function formatPubMedAuthors(authors: PubMedAuthor[]): string { return authors.map(a => a.collectiveName || `${a.lastName} ${a.firstName || a.initials}`.trim()).join("; "); }

function normalizeTextValue(value: string): string { return String(value || "").normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim(); }
function normalizeSimple(value: string): string { return String(value || "").normalize("NFKD").toLowerCase().replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, ""); }
function normalizePages(value: string): string { return String(value || "").toLowerCase().replace(/[–—−]/g, "-").replace(/\s+/g, "").replace(/^e(?=\d)/, ""); }

function titleSimilarity(a: string, b: string): number {
  const aa = tokens(a); const bb = tokens(b);
  if (!aa.size || !bb.size) return 0;
  let intersect = 0; for (const t of aa) if (bb.has(t)) intersect++;
  return (2 * intersect) / (aa.size + bb.size);
}
function journalSimilarity(a: string, b: string): number {
  const clean = (x: string) => String(x || "").toLowerCase().replace(/\([^)]*\)/g, " ").replace(/\bthe\b/g, " ");
  return titleSimilarity(clean(a), clean(b));
}
function tokens(value: string): Set<string> {
  return new Set(String(value || "").toLowerCase().replace(/<[^>]+>/g, " ").replace(/[^\p{L}\p{N}]+/gu, " ").trim().split(/\s+/).filter(Boolean));
}
