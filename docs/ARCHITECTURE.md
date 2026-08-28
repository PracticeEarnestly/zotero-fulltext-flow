# FullTextFlow architecture

FullTextFlow is **Collection-scoped by design**. It does not scan the whole Zotero library unless the user explicitly chooses a Collection that represents that scope.

## Prior art

The early Zotero–JLSS workflow design was informed by **HiYvri/pdf-fetcher**:

- https://github.com/HiYvri/pdf-fetcher

That project demonstrated a practical Zotero → JLSS request → task polling → signed PDF download → Zotero attachment workflow. FullTextFlow independently maintains and extends that concept with Collection scoping, Zotero-native retrieval first, secure/browser-assisted authentication, persistent diagnostics, verification, cancellation controls, and CI.

## Retrieval pipeline

1. User right-clicks a Zotero Collection or selected items.
2. `CollectionScanner` optionally traverses child Collections and deduplicates items.
3. `AttachmentDetector` skips items with an existing usable local PDF.
4. `Metadata` extracts DOI > PMID > title > URL.
5. `NativeFullText` delegates first-pass retrieval to `Zotero.Attachments.addAvailableFile()`.
6. If Zotero does not return a file, `FlowEngine` submits the item to JLSS.
7. `QueueStore` persists task state.
8. Background polling reads paginated JLSS task pages.
9. Remote matching prefers persisted UUID/task code, then exact query/DOI/PMID/title evidence, DOI/PMID containment, and guarded title similarity.
10. Match diagnostics persist the matching strategy, last successful match, consecutive unmatched polls, and warning state.
11. `PdfImporter` downloads the signed PDF URL into Zotero storage.
12. `PdfVerifier` runs structural checks and uses Zotero full-text extraction for DOI/title verification.
13. Results end as `done`, `review`, `failed`, or `cancelled`.
14. `TaskManager` exposes queue state, remote matching diagnostics, retry, cancellation, and cleanup actions.
15. `AutoWatcher` processes only Collections explicitly enabled by the user.

## Queue states

- `queued`
- `native_search`
- `waiting_auth`
- `submitted`
- `pending`
- `downloading`
- `done`
- `review`
- `failed`
- `cancelled`

## Sources

- `zotero`: obtained by Zotero Find Full Text machinery.
- `jlss`: obtained through JLSS / 聚联医疗 fallback.

## JLSS remote matching

The queue stores stable remote identifiers whenever they become available.

Matching order in 0.2.4:

1. persisted `uuid`;
2. persisted `taskCode`;
3. exact normalized submitted query;
4. exact DOI / PMID / Zotero title;
5. DOI or PMID contained in the remote task title;
6. guarded title-token similarity.

Title similarity is only used when the title has enough informative tokens. Ambiguous near-ties are rejected rather than forcing a potentially incorrect match.

When a remote record is matched, the plugin records:

- `matchStrategy`;
- `lastMatchedAt`;
- stable UUID/task code;
- remote task status and creation time.

When no record is matched, it records:

- `unmatchedPolls`;
- `firstUnmatchedAt`;
- a diagnostic message.

After 3 consecutive unmatched polls the task is marked as **warning/needs attention**, but remains active. This prevents a task-title rewrite or delayed remote creation from being mislabeled as a confirmed failure.

## Long-running pending tasks

A remote task that is positively matched but remains in a non-terminal JLSS state is not automatically failed. The default warning threshold is 24 hours (`pendingWarnHours`). After that threshold the task manager advises the user to check the JLSS user center.

Only explicit JLSS failure/error states are automatically classified as failed.

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

## Local state and secrets

Ordinary Zotero preferences store non-secret operational settings such as:

- polling interval;
- long-running pending warning threshold;
- maximum items per manual batch;
- whether Zotero-native lookup runs first;
- persistent fetch queue;
- enabled auto-fetch Collection keys.

JLSS username/password and token are stored through Mozilla Login Manager rather than ordinary preferences. Legacy plaintext token preferences are migrated and cleared by the authentication layer.

## JLSS integration

The current implementation uses observed JLSS endpoints:

- `POST /search/trans`
- `POST /task/myHelpList`
- `POST /task/clickDownload`

They are not treated as a guaranteed public API. Endpoint/authentication changes may require a plugin update.
