# PubMed Metadata QA

FullTextFlow 0.2.8 adds a conservative PubMed/PMC metadata-quality module for Zotero 9.

## Safety boundary

The module has two different permissions:

1. **PMID / PMCID identifiers may be added automatically when missing.**
2. **All other bibliographic metadata are read-only in 0.2.8.** Title, authors, journal, date, volume, issue, pages/article number, and DOI are compared with PubMed but are never replaced automatically.

An existing PMID, PMCID, or DOI is never silently overwritten when NCBI returns a conflicting identifier. The item is tagged `pubmed-id-conflict` instead.

## Why PMID and PMCID are stored in Extra

Current Zotero documentation treats PMID and PMCID as CSL variables that should be stored in the `Extra` field rather than as formally supported native bibliographic fields. FullTextFlow therefore writes:

```text
PMID: 12345678
PMCID: PMC1234567
```

Existing `Extra` content is preserved.

## Automatic identifier completion

Automatic PMID/PMCID completion is enabled by default and can be toggled from:

**Tools → FullTextFlow 自动补 PMID/PMCID**

The automatic watcher is deliberately conservative:

- DOI → PubMed PMID uses an exact PubMed article-identifier search.
- Existing PMID → PMCID uses the NCBI PMC ID Converter.
- PMCID absence is normal and is not treated as an error.
- Title-only or fuzzy matching is never used for automatic writes.
- If DOI and an existing PMID resolve to different PubMed records, no identifier is overwritten and the item receives `pubmed-id-conflict`.

A short delay is used after Zotero item add/modify notifications so importers can finish writing metadata before PubMed lookup begins.

## Manual identifier completion

Select one or more regular Zotero items and use:

**Right click → FullTextFlow：补全 PMID/PMCID**

The command reports updated, unchanged, not-found, conflict, and error counts.

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

A future version may offer a separate **review-and-apply** workflow for replacing metadata from PubMed. That mode is intentionally not enabled in 0.2.8. Any future write mode should show field-level differences and require explicit confirmation before modifying title, creators, journal, dates, volume, issue, pages, or DOI.
