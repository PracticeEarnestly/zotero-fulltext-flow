# FullTextFlow for Zotero

**Current preview: 0.4.2**

**FullTextFlow** is a Zotero plugin for selectively completing missing full-text PDFs at the **Collection** level. It is intended for research libraries where only high-priority project folders need complete PDFs.

The initial Zotero–JLSS workflow design was informed by the open GitHub project **[HiYvri/pdf-fetcher](https://github.com/HiYvri/pdf-fetcher)**, which demonstrated a practical Zotero → 聚联/JLSS → PDF attachment workflow. FullTextFlow is independently maintained and extends that idea with Collection-scoped execution, Zotero-native retrieval first, persistent queues, browser-assisted authentication, PDF verification, task diagnostics, cancellation controls, a stable task-table UI, and GitHub CI.

## Task center

**FullTextFlow 任务中心** combines overview and task management. Version 0.4.0 adds status filters, search, scoped selection, and separate retry/recheck/stop/remove actions. The list refreshes every two seconds; remote polling follows the configured interval. A saved token does not prove the session is still valid.

**Zotero compatibility:** version 0.4.0 supports Zotero 7–10. On Zotero 10, Collection actions use the plural selection API and can safely process one or more selected Collections without relying on removed single-selection getters.

## Core idea

You choose which Zotero Collections deserve complete full text. FullTextFlow scans only those Collections, skips items that already have usable PDFs, and follows the selected global retrieval strategy. Starting with 0.2.9, the default is **全部使用聚联**: items missing a usable local PDF are sent directly to JLSS, while Zotero-first and fallback modes remain available.

```text
Selected Zotero Collection
  -> scan regular items
  -> skip usable local PDFs
  -> apply selected retrieval strategy
       -> default: JLSS / 聚联医疗 directly
       -> optional: JLSS -> Zotero fallback
       -> optional: Zotero -> JLSS fallback
       -> optional: Zotero only
  -> persistent background queue
  -> remote task matching + diagnostics
  -> signed PDF download
  -> structural + DOI/title verification
  -> attach to original Zotero item
  -> done / needs review
```

## Main features

- Right-click a Zotero Collection and choose **补齐本分类缺失全文**.
- A manual Collection run uses one pre-run preview and confirmation dialog; see **FullTextFlow 任务管理** for progress and results.
- Optionally include all child Collections and deduplicate repeated items.
- Detect and skip items that already have a usable local PDF.
- Extract identifiers in this order: **DOI → PMID → title → URL**.
- Choose one of four global Zotero/JLSS retrieval strategies; **全部使用聚联** is the 0.2.9 default.
- Keep Zotero-first, JLSS-first-with-Zotero-fallback, and Zotero-only modes available as alternatives.
- Persist a local task queue and poll JLSS status in the background.
- Match remote JLSS tasks using UUID/task code first, then DOI/PMID/query/title evidence and guarded title similarity.
- Diagnose repeated remote-task mismatches instead of showing an unexplained generic pending state.
- Warn when a confirmed JLSS task remains in processing for a long time; long-running tasks are **not** automatically treated as failed.
- Download successful PDFs and attach them to the original Zotero item.
- Verify PDF structure and then use Zotero full-text extraction to check DOI/title consistency.
- Mark uncertain results as **需复核** instead of silently treating them as confirmed.
- Enable per-Collection automatic full-text completion for newly added items.
- Cancel selected or all local tasks without reactivating them during later polling.
- Use a stable HTML task table with sticky headers, horizontal/vertical scrolling, fixed columns, wrapped long text, and checkbox selection.

## Installation

1. Download the current XPI artifact or release package.
2. Zotero → **Tools → Plugins**.
3. Choose **Install Plugin From File...** and select the XPI.
4. Restart Zotero if requested.
5. Open **Tools → FullTextFlow 聚联登录**. You can use the embedded login flow; manual token entry remains available as a fallback.

JLSS is optional: Zotero-native retrieval can still run without a JLSS token.

## JLSS / 聚联 authentication

Recommended:

1. Zotero → **Tools → FullTextFlow 聚联账号** to save your account credentials in Mozilla Login Manager.
2. Open **Tools → FullTextFlow 聚联登录** and complete the embedded web login.
3. FullTextFlow synchronizes the web token and verifies it against the JLSS task-list API.
4. If the website requests CAPTCHA, MFA, or institution verification, complete it manually in the embedded page.

Fallback: **Tools → FullTextFlow 手动 Token（备用）**. Account password and token are not stored in ordinary Zotero preferences.

## Collection menu

Right-click one or more normal Zotero Collections:

- **补齐本分类缺失全文** — scan only the selected Collection.
- **补齐本分类及子分类缺失全文** — recursively scan child Collections and deduplicate items.
- **自动补全文此分类** — checkbox for automatic processing of newly added items directly belonging to this Collection. With multiple selected Collections, the menu applies the same setting to all selected Collections.
- **查看任务中心** — open the unified task center.
- **立即检查聚联任务** — trigger an immediate JLSS status refresh.

Automatic mode is intentionally **Collection-specific**. Enabling it on a parent Collection does not silently enable every child Collection.

## Item menu

Select one or more normal Zotero items and right-click:

- **FullTextFlow：获取缺失全文**

Items that already have a usable local PDF are skipped.

## Full-text retrieval strategy

Starting with **0.2.9**, FullTextFlow uses a global retrieval strategy shared by manual Collection runs, recursive runs, item-context actions, automatic Collection fetching, and retries.

Available modes:

1. **全部使用聚联（默认）** — skip Zotero Find Full Text and send every item missing a usable local PDF directly to JLSS.
2. **聚联优先 → Zotero 后补** — use JLSS first; only if JLSS submission fails (non-auth), the remote task explicitly fails/errors, or PDF download/import fails does Zotero Find Full Text run as a fallback. Normal JLSS/manual processing is allowed to continue without duplicate retrieval.
3. **Zotero 优先 → 聚联后补** — use Zotero Find Full Text first and submit to JLSS only when Zotero does not find a PDF.
4. **仅使用 Zotero** — never submit a JLSS task.

The strategy can be changed from either **Tools → FullTextFlow 全文获取策略** or the selected Collection's **FullTextFlow → 全文获取策略** submenu. Changing the global preference affects newly enqueued/retried work; an already-active JLSS task keeps the strategy recorded when it was submitted and is not rerouted mid-flight. Existing usable local PDFs are always skipped in every mode.

## Retrieval order

The order depends on the selected strategy. With the 0.2.9 default (**全部使用聚联**):

1. Existing usable local PDF → skip.
2. Submit directly to JLSS / 聚联医疗.
3. Remote task diagnosis and polling.
4. Download and verify the returned PDF.
5. Attach it to the original Zotero item.

Alternative modes can place Zotero Find Full Text before JLSS, use Zotero only, or use Zotero strictly as a fallback after a JLSS failure.

## JLSS task matching and pending diagnosis

FullTextFlow 0.2.4+ no longer relies only on exact equality between the submitted query and JLSS `taskTitle`.

Matching order:

1. persisted JLSS UUID;
2. persisted JLSS task code;
3. exact submitted query / DOI / PMID / Zotero title;
4. DOI or PMID contained in the remote title;
5. guarded title-token similarity when the remote task title has been rewritten.

After a match succeeds, the UUID/task code are persisted so later polling and Zotero restarts can use the stable identifiers.

If no remote record can be matched:

- the plugin records the number of consecutive unmatched polls;
- after 3 consecutive misses, the task is marked **需关注**, not failed;
- the task manager shows the last check, unmatched count, and diagnostic explanation.

If a remote task **is confirmed** but remains in a non-terminal processing state for 24 hours by default, the plugin warns you to check the JLSS user center. It does not automatically declare failure. Only explicit JLSS failure/error states are automatically classified as failed.

## PDF verification

For a JLSS PDF, FullTextFlow checks:

1. Local file exists.
2. File size is at least 10 KB.
3. File starts with `%PDF-`.
4. Zotero full-text extraction is requested.
5. If the Zotero item has a DOI, the extracted text is searched for the same DOI.
6. Otherwise or additionally, significant title-token coverage is calculated.

Possible verification states:

- `verified` — DOI or title evidence is strong.
- `inconclusive` — PDF is structurally valid but text verification is incomplete, for example a scanned PDF.
- `review` — DOI was not found and title agreement is low; inspect manually.

A structurally invalid file is removed automatically. A structurally valid but uncertain PDF is kept and flagged **需复核** so you can inspect it instead of losing a potentially correct scanned article.

## Task manager

Open **Tools → FullTextFlow 任务中心** or **Collection → FullTextFlow → 查看任务中心**.

Starting with **0.2.5**, the legacy XUL list has been replaced by a real HTML table embedded in the Zotero window. This is intended to avoid column overlap and width instability across Zotero versions, DPI scaling, and different window sizes.

In 0.4.0, filter by **进行中 / 等待登录 / 失败 / 需复核 / 已完成 / 已停止**, then search by paper title, error, or task code. All rows can be selected. **全选** selects only the current filtered results; changing filter/search clears selection. Automatic refresh preserves selection and does not rebuild unchanged rows.

The main table shows status/source, paper, explanation/next step, and last update. Click the paper to locate it in Zotero. Expand **详情** for remote IDs, matching, check timestamps, and PDF verification. The former numbered progress stages are removed because retrieval strategies do not all follow the same sequence.

Every selection action displays the number of eligible records:

| Action | Eligible states | Effect |
| --- | --- | --- |
| 重新获取 | Failed, stopped | Uses the current retrieval strategy; may submit again and consume JLSS quota. Existing usable PDFs are skipped. |
| 重新核验 PDF | Needs review | Rechecks the existing attachment; never submits to JLSS. Inconclusive results remain in review. |
| 确认 PDF 正确 | Needs review | After you inspect the PDF, marks it complete with a separate manual-verification label. Missing local attachments remain in review. |
| 停止选中 | Active, waiting for login | Stops local processing. Remote requests may continue. |
| 移除选中记录 | Completed, failed, stopped | Requires typing `清理`; removes only selected local records and retains Zotero attachments. |

**检查远端进度** checks already-submitted work without submitting new requests. **聚联登录** opens login and resumes waiting tasks after verification; already-submitted requests resume polling instead of resubmitting.

Starting with 0.4.1, explicit `当日传递次数已达上限` submission errors enter **等待额度恢复** instead of failed. New JLSS submissions pause until **00:10 the following day in the Mac's local timezone**. This is a conservative client schedule, not a verified provider reset time. Background checks resume due work within the configured polling interval; if Zotero is closed or the Mac is asleep, work continues after the next launch/wake. If the provider still reports the limit, the queue is deferred to the next local day, without repeatedly submitting the remaining batch.

Waiting tasks persist across restarts, retain their retrieval strategy, and cannot be removed by finished-history cleanup. Use **停止选中** to disable their automatic retry. Existing remote tasks continue polling/downloading; usable local PDFs are skipped. A login error pauses for login; other failures remain failed. Quota exhaustion is treated as a deferral rather than triggering Zotero fallback.

Older quota-failed records are not silently retried. Select them and choose **次日自动获取** to enroll them; records with evidence of an existing remote submission are excluded. FullTextFlow does not know the account's numeric quota. To remove failed history instead, filter **失败**, select the visible results, then **移除选中记录**.

Cancellation is a local FullTextFlow stop. If a request was already submitted to JLSS, the remote JLSS task may continue, but FullTextFlow will no longer poll or download it.

## Safety and limits

### Duplicate PDF protection (0.4.2)

FullTextFlow serializes native and JLSS retrieval for the same library/item. It checks for an existing local PDF inside that lock before downloading. JLSS files are downloaded into a private temporary directory and checked for PDF structure before being imported into Zotero.

After download it reads the item's attachments again and compares SHA-256 fingerprints. If an identical PDF arrived meanwhile, it reuses that attachment and discards only its own temporary file. If a different PDF arrived, it keeps the existing attachment, skips import, and flags the task for review. A final local-PDF check runs just before import. Verification errors after a committed import preserve the PDF for review rather than deleting it.

The lock coordinates FullTextFlow's paths, not other plugins or Zotero sync. A different app can still race during the final asynchronous commit. Protection is per item: it does not automatically merge duplicate parent items, delete existing attachments, or deduplicate across libraries. PDF recognition still requires a local PDF attachment and does not distinguish supplementary PDFs or fetch cloud-only attachments on demand.

To inspect existing duplicates without changing your library:

```sh
python3 scripts/audit_pdf_duplicates.py --data-dir /path/to/Zotero --output /path/to/new-report-folder
```

For linked files using Zotero's relative base path, also provide `--base-dir /path/to/base`. The script validates a private database snapshot, excludes trashed records, hashes size-matched local PDFs, and writes `report.md` plus full `duplicates.json`. It reports missing/unreadable files rather than treating them as unique. SHA-256 equality means equal file content, not interchangeable parent items, annotations or notes; review those before deciding whether to remove anything. Space estimates are logical byte counts and do not account for APFS clone sharing, snapshots or cloud copies.

- Default maximum items processed per manual batch: **50**.
- Default JLSS poll interval: **5 minutes**.
- Default confirmed-pending warning threshold: **24 hours**.
- JLSS submissions are sequential rather than high-concurrency.
- Existing local PDFs are skipped.
- Queue state is persisted to avoid duplicate work.
- JLSS task listing is paginated rather than limited to only the latest 20 rows.
- JLSS integration is **unofficial**. Observed endpoints are not documented as a stable public API and can change.
- Use FullTextFlow only within your institution's literature-delivery permissions, quotas, and applicable terms.

## Current version: 0.4.2 Preview

Implemented:

- Collection-scoped and recursive scanning;
- per-Collection auto mode;
- Zotero Find Full Text first;
- JLSS fallback;
- configurable four-mode Zotero/JLSS retrieval strategy (JLSS-only default);
- secure/browser-assisted JLSS authentication;
- persistent queue and background polling;
- paginated JLSS task listing;
- multi-evidence remote task matching;
- repeated-unmatched and long-running pending diagnostics;
- automatic attachment;
- structural PDF gate;
- DOI/title verification;
- stable HTML task table with checkbox selection and cancellation controls;
- GitHub Actions typecheck, UI source validation, and XPI build.

## Development workflow

Repository workflow:

```text
develop
  -> changes
  -> Pull Request
  -> GitHub Actions typecheck + UI XML/JS validation + XPI build
  -> main
```

Build locally:

```bash
npm install
npm run typecheck
npm run build:local
```

## Prior art and acknowledgement

FullTextFlow's early Zotero–JLSS integration design was informed by:

- **HiYvri/pdf-fetcher** — https://github.com/HiYvri/pdf-fetcher

That project demonstrated the feasibility of submitting literature-delivery requests from Zotero, polling JLSS tasks, obtaining a signed PDF URL, and attaching the PDF back to the Zotero item. FullTextFlow builds a broader Collection-scoped workflow around that concept and is maintained as an independent project.

## License

MIT. FullTextFlow is an independent project and is not affiliated with Zotero or JLSS/聚联医疗.
