# PubMed Metadata QA

FullTextFlow 0.2.9 adds a conservative PubMed/PMC metadata-quality module for current Zotero versions, including Zotero 9.

## Safety boundary

The module has two different permissions:

1. **PMID / PMCID identifiers may be added automatically when missing.** They are stored in Zotero's native `PMID` and `PMCID` fields for Journal Article items.
2. **All other bibliographic metadata are read-only in 0.2.9.** Title, authors, journal, date, volume, issue, pages/article number, and DOI are compared with PubMed but are never replaced automatically.

An existing PMID, PMCID, or DOI is never silently overwritten when NCBI returns a conflicting identifier. The item is tagged `pubmed-id-conflict` instead.

## Native Zotero fields

Current Zotero schema provides proper `PMID` and `PMCID` fields for `journalArticle` items. FullTextFlow therefore writes new identifiers directly to those native fields:

```text
PMID  = 12345678
PMCID = PMC1234567
```

FullTextFlow does **not** create new `PMID:` or `PMCID:` lines in `Extra`.

For backward compatibility, existing legacy lines in `Extra` can still be read as a migration source. If a legacy value exactly matches the native value being used, FullTextFlow removes only that matching identifier line from `Extra` and preserves all unrelated Extra content. If native and legacy values disagree, no automatic migration occurs and the item is tagged `pubmed-id-conflict`.

## Automatic identifier completion

Automatic PMID/PMCID completion is enabled by default and can be toggled from:

**Tools → FullTextFlow 自动补 PMID/PMCID**

The automatic watcher is deliberately conservative:

- DOI → PubMed PMID uses an exact PubMed article-identifier search.
- Existing PMID → PMCID uses the NCBI PMC ID Converter.
- PMCID absence is normal and is not treated as an error.
- Title-only or fuzzy matching is never used for automatic writes.
- Native Zotero `PMID` / `PMCID` fields are authoritative.
- Legacy `Extra` identifiers are only read for migration/compatibility.
- If DOI, native fields, legacy Extra identifiers, or NCBI mappings conflict, no identifier is overwritten and the item receives `pubmed-id-conflict`.

A short delay is used after Zotero item add/modify notifications so importers can finish writing metadata before PubMed lookup begins.

## Manual identifier completion

Select one or more regular Zotero items and use:

**Right click → FullTextFlow：补全 PMID/PMCID**

The command reports updated, unchanged, not-found, conflict, skipped, and error counts.

## Read-only metadata validation

Select one or more regular Zotero items and use:

**Right click → FullTextFlow：PubMed 校验 metadata（不修改）**

The validator compares the Zotero record with PubMed and never replaces bibliographic metadata in this version.

Strong-conflict checks currently include:

- title;
- DOI;
- publication year;
- volume.

Issue, pages/article number, journal title, and first-author differences are reported as review information but are not by themselves treated as strong conflicts because database formatting differs across publishers and PubMed.

Validation tags:

- `pubmed-metadata-verified`
- `pubmed-metadata-conflict`

These tags record the current validation state. They do not mean that PubMed metadata were copied into Zotero.

## NCBI API use

The module uses official NCBI services:

- PubMed E-utilities for DOI → PMID lookup and PubMed summaries;
- PMC ID Converter for PMID ↔ PMCID linkage when the article is available in PMC.

Requests are serialized and throttled to stay below the default unauthenticated NCBI request rate. NCBI recommends that API clients identify a maintainer email. It can be configured from:

**Tools → FullTextFlow NCBI 联系邮箱**

The email is used only as an NCBI API query parameter.

## Future write mode

A future version may offer a separate **review-and-apply** workflow for replacing bibliographic metadata from PubMed. That mode is intentionally not enabled in 0.2.9. Any future write mode should show field-level differences and require explicit confirmation before modifying title, creators, journal, dates, volume, issue, pages, or DOI.
