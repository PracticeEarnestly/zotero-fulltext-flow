# PubMed Metadata QA

FullTextFlow 0.3.0 provides PubMed/PMC identifier QA, read-only metadata validation, and an explicit review-and-replace workflow for current Zotero versions, including Zotero 9.

## Safety boundary

The module has three distinct modes:

1. **PMID / PMCID identifiers may be added automatically when missing.** They are stored in Zotero's native `PMID` and `PMCID` fields for Journal Article items.
2. **PubMed metadata validation remains read-only.** The existing validation command never replaces bibliographic metadata.
3. **Metadata replacement is manual and confirmation-gated.** Every item shows field-level Zotero → PubMed differences before any write occurs.

An existing PMID, PMCID, or DOI is never silently overwritten when NCBI returns a conflicting identifier. The item is tagged `pubmed-id-conflict` instead.

## Native Zotero fields

Current Zotero schema provides proper `PMID` and `PMCID` fields for `journalArticle` items. FullTextFlow writes new identifiers directly to those native fields and does **not** create new `PMID:` or `PMCID:` lines in `Extra`.

For backward compatibility, legacy identifier lines in `Extra` can still be read as a migration source. Matching legacy lines are removed only after the same value is present in the native field; unrelated Extra content is preserved. Native/legacy conflicts are never overwritten automatically.

## Automatic identifier completion

Automatic PMID/PMCID completion is enabled by default and can be toggled from:

**Tools → FullTextFlow 自动补 PMID/PMCID**

Automatic writes are conservative:

- DOI → PMID uses an exact PubMed article-identifier search.
- Existing PMID → PMCID uses the NCBI PMC ID Converter.
- PMCID absence is normal and is not treated as an error.
- Title-only/fuzzy matching is never used for automatic identifier writes.

## Read-only metadata validation

Select one or more regular Zotero items and use:

**Right click → FullTextFlow：PubMed 校验 metadata（不修改）**

The validator compares title, DOI, publication year, volume, issue, pages/article number, journal title, and first author. It never replaces bibliographic metadata.

Validation tags:

- `pubmed-metadata-verified`
- `pubmed-metadata-conflict`

## Confirmed metadata replacement

Select one or more regular Zotero items and use:

**Right click → FullTextFlow：PubMed 校验并替换 metadata…**

For each item, FullTextFlow first retrieves the PubMed record and previews the exact differences. No replacement occurs until the user confirms that specific item.

Eligible replacement fields are:

- title;
- journal title;
- journal abbreviation;
- publication date when PubMed is more informative or the year conflicts;
- volume;
- issue;
- pages/article number;
- DOI.

PMID and PMCID remain managed by the native identifier QA flow rather than the general metadata replacement operation.

### Authors

Structured author data are retrieved from PubMed XML using `LastName`, `ForeName`, `Initials`, and `CollectiveName` rather than splitting display strings.

When the PubMed author list differs from Zotero, the confirmation dialog offers two choices:

- **替换（保留作者）** — replace the other confirmed fields but leave Zotero authors unchanged;
- **替换（含作者）** — also replace author creators using structured PubMed data.

Non-author creator roles are preserved.

### Data that are never replaced

The metadata replacement action does not replace or delete:

- attachments/PDFs;
- notes;
- tags;
- Collection membership;
- unrelated `Extra` content.

After a confirmed write, the item receives `pubmed-metadata-updated`. Previous validation tags are cleared because they may be stale until the next validation run.

## NCBI API use

The module uses official NCBI services:

- PubMed E-utilities for DOI → PMID lookup and summary metadata;
- PubMed EFetch XML for structured authors;
- PMC ID Converter for PMID ↔ PMCID linkage when the article is available in PMC.

Requests are serialized and throttled below the default unauthenticated NCBI request rate. An optional NCBI contact email can be configured from:

**Tools → FullTextFlow NCBI 联系邮箱**
