# FullTextFlow for Zotero

**Current preview: 0.2.3**

**FullTextFlow** is a Zotero plugin for selectively completing missing full-text PDFs at the **Collection** level. It is intended for research libraries where only high-priority project folders need complete PDFs.

## Core idea

You choose which Zotero Collections deserve complete full text. FullTextFlow scans only those Collections, skips items that already have usable PDFs, asks Zotero's own **Find Full Text** machinery first, and uses JLSS / 聚联医疗 as a fallback when Zotero cannot obtain the file.

```text
Selected Zotero Collection
  -> scan regular items
  -> skip usable local PDFs
  -> Zotero Find Full Text
       -> DOI / URL / OA / custom resolvers
  -> if still missing: JLSS / 聚联医疗
  -> persistent background queue
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
- Try Zotero's built-in file resolvers first: DOI, URL, Open Access, and configured custom resolvers.
- Fall back to JLSS / 聚联医疗 literature delivery only when Zotero does not find a file.
- Persist a local task queue and poll JLSS status in the background.
- Download successful PDFs and attach them to the original Zotero item.
- Verify PDF structure and then use Zotero full-text extraction to check DOI/title consistency.
- Mark uncertain results as **需复核** instead of silently treating them as confirmed.
- Enable per-Collection **automatic full-text completion** for newly added items.
- Keep low-priority Collections untouched.
- Open a task manager window from either the Collection menu or Zotero Tools menu.

## Installation

1. Download `fulltextflow-0.2.3.xpi`.
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

## Retrieval order

By default:

1. Existing local PDF → skip.
2. Zotero Find Full Text → DOI / URL / OA / custom resolver.
3. JLSS / 聚联医疗 fallback.
4. PDF verification.
5. Attach to the original item.

This reduces unnecessary JLSS requests and preserves your institution's delivery quota.

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

The 0.2.3 task manager refreshes the UI every 2 seconds and shows, for each item:

- task state and stage (`1/5` … `5/5`);
- current operation (Zotero lookup, JLSS submission, manual lookup, download/verification);
- source (`Zotero` or `聚联`);
- article title;
- JLSS task code and remote status;
- elapsed time;
- last JLSS check and next scheduled check;
- PDF verification status and detailed notes.

Actions:

- **立即检查聚联任务**;
- **重试失败/需复核**;
- **取消选中任务** — supports multi-select;
- **取消全部进行中**;
- **清理已完成/已取消**.

Cancellation is a local FullTextFlow stop. If a request was already submitted to JLSS, the remote JLSS task may continue, but FullTextFlow will no longer poll or download it. A deliberately re-run Collection/item can enqueue a previously cancelled item again.

## Safety and limits

- Default maximum items processed per manual batch: **50**.
- JLSS submissions are sequential rather than high-concurrency.
- Existing local PDFs are skipped.
- Queue state is persisted in Zotero preferences to avoid duplicate work.
- JLSS task matching prefers saved UUID/task code when available, then falls back to normalized task title.
- JLSS task listing is paginated rather than limited to only the latest 20 rows.
- JLSS integration is **unofficial**. Observed endpoints are not documented as a stable public API and can change.
- Use FullTextFlow only within your institution's literature-delivery permissions, quotas, and applicable terms.

## Current version: 0.2.3 Preview

Implemented:

- Collection-scoped and recursive scanning;
- per-Collection auto mode with visible checkbox state;
- Zotero Find Full Text first;
- JLSS fallback;
- persistent queue and background polling;
- JLSS task pagination and UUID/task-code preference;
- automatic attachment;
- structural PDF gate;
- DOI/title verification;
- live task manager with detailed progress and cancellation controls.

Not yet validated in this repository environment:

- live end-to-end operation against your personal Zotero profile and JLSS account;
- every Zotero 7/8/9 UI variation;
- scanned-PDF OCR verification.

## Build

Standard development build after installing dependencies:

```bash
npm install
npm run typecheck
npm run build
```

A dependency-light local build is also included:

```bash
npm run build:local
```

`build:local` assembles the TypeScript sources, compiles them with `tsc`, builds the Zotero add-on directory, creates the XPI, and emits a SHA-256 checksum.

## License

MIT. FullTextFlow is an independent implementation and is not affiliated with Zotero or JLSS/聚联医疗.

## 聚联自动登录（0.2.3）

首次使用：

1. Zotero → **工具 → FullTextFlow 聚联账号**。
2. 在本机输入聚联账号和密码；凭证保存到 Mozilla Login Manager，不写入普通 Zotero Preferences。
3. 插件打开内置聚联登录页，尝试自动填表并登录。
4. 登录成功后，插件自动读取网页 Local Storage 中的 `token`、验证连接，并恢复 `waiting_auth` 队列。
5. 若聚联要求验证码、MFA 或机构验证，插件不会绕过；请在内置网页登录页手动完成一次，之后会自动捕获 token。

备用：**工具 → FullTextFlow 手动 Token（备用）**。0.2.0 里已保存的明文 token 会在首次启动新版时迁移到 Login Manager 并从普通首选项清空。



## 0.2.2 登录同步修复

如果聚联网页已经显示登录成功，但全文检索仍提示“需要登录”，0.2.2 会依次通过页面存储、Gecko 内容进程和 DOM Web Storage 管理器捕获并验证 token。只有 `/task/myHelpList` API 验证通过后，界面才显示“聚联 API 登录验证成功”。


## 0.2.3 任务进度与取消

任务窗口不再把所有活动状态笼统显示为“待处理”。它会分别显示 Zotero 查找、等待提交、聚联已提交、聚联查找中、下载/核验中、等待登录、完成、需复核、失败和已取消，并显示已等待时间、任务号以及上次/下次检查时间。

选择一条或多条任务后可点击 **取消选中任务**；也可以 **取消全部进行中**。取消后状态固定为 `cancelled`，不会再进入后台轮询。
