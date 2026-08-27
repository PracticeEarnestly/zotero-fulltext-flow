# Changelog

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
