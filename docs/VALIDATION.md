# Validation record

## 0.2.0 build checks

Completed in the build environment:

- TypeScript combined-source compilation: PASS
- Runtime JavaScript syntax check: PASS
- Task-manager JavaScript syntax check: PASS
- XUL/XML parse: PASS
- Manifest JSON parse/version check: PASS
- Unexpanded build-placeholder check: PASS
- XPI ZIP integrity: PASS
- Mocked Zotero runtime startup/shutdown smoke test: PASS

## Functional logic added in 0.2.0

- Native Zotero retrieval before JLSS fallback.
- JLSS queue persistence and background polling.
- Paginated task listing.
- UUID/task-code-preferred task matching.
- Collection auto-fetch checkbox state.
- PDF structural validation.
- DOI/title identity verification using Zotero extracted text.
- Task manager UI.

## Still requires real-profile validation

A local build environment cannot validate account- and UI-dependent behavior. Before treating 0.2.0 as stable, test at least:

1. Zotero 7 stable with one Collection containing 3–5 items.
2. One item with an existing PDF (must skip).
3. One OA item that Zotero can find directly (must not submit to JLSS).
4. One item that requires JLSS (must submit, poll, download, attach).
5. One pending manual JLSS task (must persist across Zotero restart).
6. Collection auto-fetch enabled/disabled behavior.
7. Task manager display and refresh.
8. A scanned PDF to confirm `inconclusive` behavior.
9. A deliberately mismatched PDF in a test environment to confirm `review` behavior.

Do not bulk-submit a large Collection until the small test passes.


## 0.2.3 build checks

- Combined TypeScript compilation: PASS
- Runtime JavaScript syntax: PASS
- Task-manager JavaScript syntax: PASS
- XUL/XML parse: PASS
- Manifest version / placeholder audit: PASS
- XPI ZIP integrity: PASS
- Cancellation state excluded from active polling by design.
- In-flight cancellation guards added around native lookup, JLSS submit, JLSS poll, download, and verification.
- Real Zotero UI testing of multi-select cancellation is still recommended before bulk use.
