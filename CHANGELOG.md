# Changelog

## 0.3.1 - 2026-09-02

- Changed PubMed title handling to prefer EFetch XML `ArticleTitle` over ESummary display title when available.
- Added Zotero-safe title normalization before both validation and replacement.
- Removed ordinary terminal citation periods from PubMed titles so Zotero stores the title itself and CSL controls bibliography punctuation.
- Preserved terminal question marks and exclamation marks.
- Preserved periods that are likely part of true terminal abbreviations such as `U.S.`, `U.K.`, `e.g.`, `i.e.`, `et al.`, `vs.`, and `etc.`.
- Reused the same PubMed XML request for structured authors and the preferred article title.

## 0.3.0 - 2026-09-02

- Added **PubMed 校验并替换 metadata…** as an explicit, per-item confirmation workflow.
- Added field-level Zotero → PubMed difference preview before any bibliographic metadata write.
- Added confirmed replacement for title, journal title, journal abbreviation, publication date, volume, issue, pages/article number, and DOI.
- Added structured PubMed XML author retrieval and explicit choices to replace metadata while keeping Zotero authors or to replace metadata including authors.
- Preserved non-author creators, attachments, notes, tags, Collection membership, and unrelated Extra content.
- Kept the existing **PubMed 校验 metadata（不修改）** workflow read-only and kept background metadata replacement disabled.

## 0.2.9 - 2026-09-02

- Corrected PMID/PMCID storage for current Zotero schema: Journal Article items now use Zotero's native `PMID` and `PMCID` fields instead of creating new identifier lines in `Extra`.
- Native fields are authoritative; legacy `PMID:` / `PMCID:` lines in `Extra` are read only for backward-compatible migration.
- When a legacy Extra identifier exactly matches the native identifier being used, only that matching legacy line is removed while all unrelated Extra content is preserved.
- If native and legacy identifiers disagree, no automatic migration or overwrite occurs and the item receives `pubmed-id-conflict`.
- FullTextFlow's general metadata extractor now prefers the native PMID field and falls back to legacy Extra only for older records.
- PubMed metadata validation remains read-only for title, creators, journal, date, volume, issue, pages/article number, and DOI.

## 0.2.8 - 2026-09-02

- Added a Zotero 9 PubMed metadata QA module using official NCBI services.
- Added default-on automatic PMID/PMCID completion for newly added or modified regular items.
- Automatic identifier writes are conservative: DOI or an existing PMID are required; title-only fuzzy matching is never used for writes.
- Initial preview stored PMID/PMCID as legacy `Extra` lines; this is corrected in 0.2.9 to use Zotero native fields.
- Added DOI → PMID lookup through PubMed E-utilities and PMID → PMCID linkage through the PMC ID Converter.
- Added identifier conflict protection: existing DOI/PMID/PMCID values are never silently overwritten when NCBI returns a conflicting mapping; conflicts receive the `pubmed-id-conflict` tag.
- Added right-click **补全 PMID/PMCID** for manual batch completion.
- Added right-click **PubMed 校验 metadata（不修改）** to compare title, DOI, year, volume, issue, pages/article number, journal, and first author with PubMed.
- Metadata validation is read-only; no title, creator, journal, date, volume, issue, pages, or DOI field is replaced.
- Added `pubmed-metadata-verified` and `pubmed-metadata-conflict` validation tags.
- Added a Tools toggle for automatic identifier completion and an optional NCBI contact-email preference.
- Serialized and throttled NCBI requests to remain below the default unauthenticated request rate.

## 0.2.7 - 2026-08-28

- Added a global four-mode full-text retrieval strategy shared by manual Collection runs, recursive runs, item-context actions, automatic Collection fetching, and retries.
- Changed the default strategy to **全部使用聚联** (`jlss_only`), matching the primary workflow preference for direct JLSS retrieval.
- Added **聚联优先 → Zotero 后补** (`jlss_then_zotero`): Zotero is only attempted after non-auth JLSS submission failure, explicit remote failure/error, or PDF download/import failure; normal JLSS/manual processing does not trigger duplicate fallback retrieval.
- Retained **Zotero 优先 → 聚联后补** (`zotero_then_jlss`) as the former behavior and added **仅使用 Zotero** (`zotero_only`).
- Added mutually exclusive strategy radio menus under both Tools and Collection FullTextFlow menus.
- Each queue entry records the strategy used at enqueue time so changing the global setting does not reroute already-active JLSS work.
- Batch confirmation, result summaries, and task overview now show the current retrieval strategy.
- Replaced the legacy `nativeFirst` default with `retrievalStrategy`.
- Preserved acknowledgement of the prior-art/reference project `HiYvri/pdf-fetcher`.

## 0.2.6 - 2026-08-28

- Fixed false-positive JLSS login status when an old API token remained usable after the JLSS website session had expired.
- Login state is now verified on two independent layers: API token validity and embedded JLSS web-session validity.
- Only API + confirmed web session is displayed as **聚联登录成功**.
- API-valid but web-session-unknown state is now shown as a warning instead of success.
- Web-session-expired state is detected from login-route, password-field, and login/register page markers and prompts re-login even if the API token temporarily still works.
- A still-valid API token is retained during web-session re-login so active background tasks are not interrupted unnecessarily.
- Added both direct DOM and Gecko frame-script web-session probes for Zotero/Firefox process-isolation compatibility.
- Added red/amber/green authentication status semantics and a dual-login detection button.
- Added dedicated authentication/session documentation and privacy-safe issue templates.

## 0.2.5 - 2026-08-28

- Replaced the legacy XUL `listbox/listheader/listcell` task view with a real HTML table embedded in the Zotero task window.
- Added sticky table headers and reliable horizontal/vertical scrolling for wide task diagnostics.
- Added explicit fixed column widths so DPI scaling and window resizing no longer cause XUL column overlap or unpredictable stretching.
- Long fields such as article title and diagnostics now wrap normally; status/time fields stay compact and non-wrapping.
- Replaced fragile XUL multi-selection with per-row checkboxes plus a Select All checkbox.
- Checkbox selection persists across the 2-second automatic task refresh.
- Terminal tasks are not selectable for cancellation.
- Added row highlighting for selected, warning, and cancelled tasks.
- Added build-time XML parsing and JavaScript syntax checks for both FullTextFlow windows, in addition to the existing TypeScript/XPI build gate.

## 0.2.4 - 2026-08-28

- Improved JLSS remote-task matching beyond exact submitted-text equality.
- Matching now prefers persisted UUID/task code, then DOI/PMID/query/title exact matches, DOI/PMID containment, and finally guarded title-similarity matching.
- Added persisted match strategy and last successful remote-match time.
- Added consecutive unmatched-poll counters and first-unmatched timestamps.
- Added a default 24-hour warning threshold for confirmed remote tasks that remain in processing; long-running work is warned about but not automatically failed.
- Added a warning after 3 consecutive polls where no JLSS remote record can be matched.
- Expanded the task manager with remote-match strategy, last match time, warning counts, and diagnostic messages.
- Added explicit project acknowledgement of the prior-art/reference project `HiYvri/pdf-fetcher` in the README and architecture documentation.

## 0.2.3 - 2026-08-24

- Redesigned task manager with live 2-second UI refresh and per-item progress stages.
- Added elapsed time, JLSS task code/status, last check, next check, verification, and detailed status messages.
- Added `cancelled` terminal state.
- Added multi-select **Cancel selected tasks** and **Cancel all active tasks** actions.
- Added cleanup for completed/cancelled tasks.
- Cancellation stops FullTextFlow local polling/download. If a request was already submitted to JLSS, the remote JLSS task may continue.
- Added cancellation race guards around native lookup, JLSS submission, polling, and PDF import so a cancelled job is not silently reactivated.

## 0.2.2 - 2026-08-24

- Fixed the case where the embedded JLSS page is visibly logged in but API requests still report that login is required.
- Added three token-capture paths: direct page storage, Gecko content-process frame script, and privileged DOM localStorage manager.
- JLSS API calls now attempt to recover a newer web token when the secure-store token is missing or rejected.
- Improved authentication status messages to distinguish “web page logged in” from “API token verified”.

## 0.2.1 - 2026-08-24

- Added JLSS browser-assisted automatic login inside Zotero.
- Added secure username/password/token storage via Mozilla Login Manager.
- Added automatic form-fill heuristics for the JLSS login page.
- Added automatic token capture from JLSS Local Storage after login.
- Added `waiting_auth` queue state so missing/expired login no longer turns every paper into a failed task.
- After successful login, waiting tasks resume automatically.
- Added manual token fallback and token migration from 0.2.0 plaintext preferences.
- CAPTCHA/MFA/extra institution verification is never bypassed; the embedded page remains interactive for manual completion.

## 0.2.0 - 2026-08-24

### Added

- Zotero-native Find Full Text lookup before JLSS fallback.
- DOI/title verification using Zotero full-text extraction.
- `verified`, `inconclusive`, and `review` verification outcomes.
- Task manager window with poll, retry/reverify, and clear-completed actions.
- Visible checkbox state for Collection auto-fetch.
- Source tracking (`zotero` vs `jlss`).
- UUID/task-code-preferred matching for known JLSS tasks.
- Dependency-light `build:local` XPI build script.

### Changed

- Manual Collection execution now reports how many PDFs Zotero found directly versus how many were submitted to JLSS.
- Review and failed states are separated from active background polling.
- JLSS remains a fallback rather than the first retrieval path by default.

### Safety

- Structurally invalid downloads are removed.
- Structurally valid but text-mismatched PDFs are retained and marked `review` instead of being silently accepted.

## 0.1.0 - 2026-08-24

- Initial Collection-scoped FullTextFlow preview.
- Collection scanning and recursive scanning.
- Per-Collection automatic mode.
- JLSS submission, polling, pagination, download and automatic Zotero attachment.
- Basic PDF integrity checks.
