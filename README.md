# FullTextFlow for Zotero

**Current preview: 0.2.7**

**FullTextFlow** is a Zotero plugin for selectively completing missing full-text PDFs at the **Collection** level. It is intended for research libraries where only high-priority project folders need complete PDFs.

The initial Zotero–JLSS workflow design was informed by the open GitHub project **[HiYvri/pdf-fetcher](https://github.com/HiYvri/pdf-fetcher)**, which demonstrated a practical Zotero → 聚联/JLSS → PDF attachment workflow. FullTextFlow is independently maintained and extends that idea with Collection-scoped execution, Zotero-native retrieval first, persistent queues, browser-assisted authentication, PDF verification, task diagnostics, cancellation controls, a stable task-table UI, and GitHub CI.

## Core idea

You choose which Zotero Collections deserve complete full text. FullTextFlow scans only those Collections, skips items that already have usable PDFs, and follows the selected global retrieval strategy. Starting with 0.2.7, the default is **全部使用聚联**: items missing a usable local PDF are sent directly to JLSS, while Zotero-first and fallback modes remain available.

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
- Optionally include all child Collections and deduplicate repeated items.
- Detect and skip items that already have a usable local PDF.
- Extract identifiers in this order: **DOI → PMID → title → URL**.
- Choose one of four global Zotero/JLSS retrieval strategies; **全部使用聚联** is the 0.2.7 default.
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

Right-click a normal Zotero Collection:

- **补齐本分类缺失全文** — scan only the selected Collection.
- **补齐本分类及子分类缺失全文** — recursively scan child Collections and deduplicate items.
- **自动补全文此分类** — checkbox for automatic processing of newly added items directly belonging to this Collection.
- **查看任务** — open the task manager.
- **立即检查聚联任务** — trigger an immediate JLSS status refresh.

Automatic mode is intentionally **Collection-specific**. Enabling it on a parent Collection does not silently enable every child Collection.

## Item menu

Select one or more normal Zotero items and right-click:

- **FullTextFlow：获取缺失全文**

Items that already have a usable local PDF are skipped.

## Full-text retrieval strategy

Starting with **0.2.7**, FullTextFlow uses a global retrieval strategy shared by manual Collection runs, recursive runs, item-context actions, automatic Collection fetching, and retries.

Available modes:

1. **全部使用聚联（默认）** — skip Zotero Find Full Text and send every item missing a usable local PDF directly to JLSS.
2. **聚联优先 → Zotero 后补** — use JLSS first; only if JLSS submission fails (non-auth), the remote task explicitly fails/errors, or PDF download/import fails does Zotero Find Full Text run as a fallback. Normal JLSS/manual processing is allowed to continue without duplicate retrieval.
3. **Zotero 优先 → 聚联后补** — use Zotero Find Full Text first and submit to JLSS only when Zotero does not find a PDF.
4. **仅使用 Zotero** — never submit a JLSS task.

The strategy can be changed from either **Tools → FullTextFlow 全文获取策略** or the selected Collection's **FullTextFlow → 全文获取策略** submenu. Changing the global preference affects newly enqueued/retried work; an already-active JLSS task keeps the strategy recorded when it was submitted and is not rerouted mid-flight. Existing usable local PDFs are always skipped in every mode.

## Retrieval order

The order depends on the selected strategy. With the 0.2.7 default (**全部使用聚联**):

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

Open **Tools → FullTextFlow 任务管理** or **Collection → FullTextFlow → 查看任务**.

Starting with **0.2.5**, the legacy XUL list has been replaced by a real HTML table embedded in the Zotero window. This is intended to avoid column overlap and width instability across Zotero versions, DPI scaling, and different window sizes.

The task table provides:

- sticky column headers;
- stable explicit column widths;
- horizontal and vertical scrolling;
- normal wrapping for article titles and diagnostics;
- compact non-wrapping status/time columns;
- checkbox-based row selection plus Select All;
- selection persistence during the 2-second automatic refresh;
- warning highlighting for tasks needing attention;
- disabled selection for terminal tasks that can no longer be cancelled.

For each item, the table shows:

- task state and stage (`1/5` … `5/5`);
- current operation;
- source (`Zotero` or `聚联`);
- article title;
- JLSS task code and remote status;
- remote matching strategy or `未匹配 ×N`;
- elapsed time;
- last successful remote match;
- last JLSS check and next scheduled check;
- PDF verification status;
- diagnostic explanation.

The summary also shows **⚠ 需关注** when a task has repeated remote-match failures or has exceeded the configured long-running threshold.

Actions:

- **立即检查聚联任务**;
- **重试失败/需复核**;
- **取消选中任务** — select using the first-column checkboxes;
- **取消全部进行中**;
- **清理已完成/已取消**.

Cancellation is a local FullTextFlow stop. If a request was already submitted to JLSS, the remote JLSS task may continue, but FullTextFlow will no longer poll or download it.

## Safety and limits

- Default maximum items processed per manual batch: **50**.
- Default JLSS poll interval: **5 minutes**.
- Default confirmed-pending warning threshold: **24 hours**.
- JLSS submissions are sequential rather than high-concurrency.
- Existing local PDFs are skipped.
- Queue state is persisted to avoid duplicate work.
- JLSS task listing is paginated rather than limited to only the latest 20 rows.
- JLSS integration is **unofficial**. Observed endpoints are not documented as a stable public API and can change.
- Use FullTextFlow only within your institution's literature-delivery permissions, quotas, and applicable terms.

## Current version: 0.2.7 Preview

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
