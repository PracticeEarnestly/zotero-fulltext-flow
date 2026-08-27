# FullTextFlow architecture

FullTextFlow is **Collection-scoped by design**. It does not scan the whole Zotero library unless the user explicitly chooses a Collection that represents that scope.

## Retrieval pipeline

1. User right-clicks a Zotero Collection or selected items.
2. `CollectionScanner` optionally traverses child Collections and deduplicates items.
3. `AttachmentDetector` skips items with an existing usable local PDF.
4. `Metadata` extracts DOI > PMID > title > URL.
5. `NativeFullText` delegates first-pass retrieval to `Zotero.Attachments.addAvailableFile()`.
6. If Zotero does not return a file, `FlowEngine` submits the item to JLSS.
7. `QueueStore` persists state in Zotero preferences.
8. Background polling reads paginated JLSS task pages.
9. JLSS task matching prefers stored UUID/task code and falls back to normalized task title.
10. `PdfImporter` downloads the signed PDF URL into Zotero storage.
11. `PdfVerifier` runs structural checks and uses Zotero full-text extraction for DOI/title verification.
12. Results end as `done`, `review`, or `failed`.
13. `TaskManager` exposes queue state and retry/cleanup actions.
14. `AutoWatcher` processes only Collections explicitly enabled by the user.

## Queue states

- `queued`
- `native_search`
- `submitted`
- `pending`
- `downloading`
- `done`
- `review`
- `failed`

## Sources

- `zotero`: obtained by Zotero Find Full Text machinery.
- `jlss`: obtained through JLSS / 聚联医疗 fallback.

## Verification

`PdfVerifier` distinguishes file validity from document identity.

### Structural checks

- local path exists;
- file size >= 10 KB;
- `%PDF-` signature.

Structural failure removes the attachment.

### Identity checks

The plugin asks Zotero to index the attachment and reads Zotero's extracted full-text cache.

- Exact normalized DOI in extracted text => `verified`.
- Significant title-token coverage >= 0.62 => `verified`.
- Intermediate title coverage => `inconclusive`.
- Low title coverage and no target DOI => `review`.
- No extractable text => `inconclusive`.

A `review` PDF is kept for manual inspection because scanned or unusual PDFs can produce false-negative text checks.

## Local state

Zotero preferences store:

- JLSS token;
- polling interval;
- maximum items per manual batch;
- whether Zotero-native lookup runs first;
- persistent fetch queue;
- enabled auto-fetch Collection keys.

The plugin does not store the JLSS username or password.

## JLSS integration

The current implementation uses observed JLSS endpoints:

- `POST /search/trans`
- `POST /task/myHelpList`
- `POST /task/clickDownload`

They are not treated as a guaranteed public API. Endpoint/authentication changes may require a plugin update.
