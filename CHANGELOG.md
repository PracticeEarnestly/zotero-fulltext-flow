# Changelog

## 0.5.0 - 2026-10-25

- Add a dedicated same-parent duplicate PDF manager, available from Tools and the task center. Scan selected items or the captured library, group local equal-size/SHA-256 PDFs, inspect files, choose keepers, and explicitly select copies for recoverable trash.
- Protect attachments with Zotero annotations/notes (including trashed child records), linked files, shared paths, and insufficient permissions. Never merge across parent items or permanently erase files.
- Require typed confirmation and revalidate each group against trusted scan snapshots, then check live metadata inside the Zotero transaction. Report skipped files and partial batch failures; retain at least the chosen keeper. Scanning is cancellable and makes no attachment changes.
- Add isolated UI preview and regression tests for same-parent scope, stale files/metadata, protected attachments, cancellation, keeper selection, confirmation, and accurate failure feedback.

## 0.4.2 - 2026-10-25

- Serialize native and JLSS downloads per library/item, and recheck local PDFs inside the lock before download and again immediately before import.
- Stage JLSS downloads in private temporary storage, validate PDF structure, and compare SHA-256 content fingerprints against same-item PDFs that arrived during download. Reuse identical attachments and discard only the temporary copy; different arriving PDFs are preserved and flagged for review.
- Keep committed attachments on later verification errors instead of deleting them. Existing PDFs, annotations and cross-item attachments are never automatically removed by deduplication.
- Add a read-only duplicate audit script producing full JSON and Markdown reports with file hashes, paths, parent items, annotation counts, missing-file coverage, and logical redundant-byte estimates.


## 0.4.1 - 2026-10-25

- Preserve daily-quota rejections as `waiting_quota`, with a persisted next attempt at 00:10 the following local day. Background checks resume overdue work after restart; another quota rejection defers waiting tasks to the next day.
- Share a persisted quota backoff across serialized submission batches; existing remote tasks continue polling and downloading. Automatic retries retain the recorded retrieval strategy, skip existing PDFs, and respect batch limits and cancellation.
- Add a waiting-quota filter, scheduled time, and an explicit action for enrolling selected legacy quota-failed records. Generic failures and stopped tasks never enroll automatically.
- The schedule is a conservative client policy, not a verified JLSS reset time. Quota exhaustion is deferred instead of triggering Zotero fallback; other failures retain the configured fallback behavior.

## 0.4.0 - 2026-10-25

- Reorganize the task center around status filters, search, selection counts, and scoped actions. Terminal records can now be selected for retry/removal; hidden rows are never included.
- Replace the 14-column table and numbered stages with a compact six-column table, actionable explanations, expandable diagnostics, and links to the Zotero item.
- Separate retrying failed/stopped tasks from rechecking existing review PDFs. Removal still requires typing `清理` and preserves active/review records and PDF attachments.
- Allow explicit manual confirmation after PDF inspection, recorded separately from automatic verification; missing attachments remain in review.
- Explain JLSS daily-quota failures without assuming an account-specific limit or reset time. Saved tokens are no longer presented as proof of a valid session.
- Fix retries being skipped after premature queue reset. Preserve excess batch entries, resume submitted tasks after login without resubmission, and ignore late state transitions after cancellation.

## 0.3.3 - 2026-10-25

- Require typing `清理` before completed/failed/cancelled task records are removed, so dismissing or accidentally accepting a native dialog cannot clear task history.

## 0.3.2 - 2026-10-25

- Fixed failed tasks being impossible to remove from the local task center.
- Expanded terminal-record cleanup to include completed, failed, and cancelled tasks while preserving review records.
- Added a confirmation summary explaining that cleanup does not delete Zotero PDFs or cancel JLSS remote tasks.
- Added queue-state regression tests for terminal, clearable, review, and active states.

## 0.3.1 - 2026-10-15

- Added Zotero 10 compatibility: the XPI manifest and automatic-update manifest now declare `strict_max_version: 10.0.*`.
- Replaced the removed single-Collection getter with the Zotero 10 plural selection API, while retaining Zotero 7–9 fallback behavior.
- Collection actions and automatic full-text setting now safely support one or more selected Collections, with cross-Collection item deduplication.


## 0.3.0 - 2026-10-15

- Merged **任务概览** into **FullTextFlow 任务中心**.
- The task-center header refreshes every two seconds and shows retrieval strategy, JLSS token and automatic-login status, active task count, and all queue-state counts.
- Removed the separate Tools → FullTextFlow 任务概览 menu item. Collection actions now open “查看任务中心”.


## 0.2.9 - 2026-10-15

- Added a Zotero JSON update manifest (update.json) to every release.
- The manifest includes the versioned XPI URL, SHA-256 update hash, and tested Zotero version range, enabling automatic update checks.
- Release automation now uploads the XPI, its SHA-256 file, and update.json together.

## 0.2.8 - 2026-10-15

- Collection right-click runs now keep only the pre-run task preview and confirmation dialog.
- Removed the second post-enqueue summary dialog. Progress, result counts, and diagnostics remain available in **FullTextFlow 任务管理**.
- A required JLSS login window still opens when authentication is needed.

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
- Long fields such as article title and diagnostic explanation now wrap normally; status/time fields stay compact and non-wrapping.
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
