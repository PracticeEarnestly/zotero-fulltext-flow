#!/usr/bin/env python3
from pathlib import Path
import json


def replace(path: str, old: str, new: str):
    p = Path(path)
    text = p.read_text()
    if old not in text:
        raise SystemExit(f"Expected text not found in {path}: {old[:120]!r}")
    p.write_text(text.replace(old, new, 1))


Path("src/core/RetrievalStrategy.ts").write_text('''import { PREF_PREFIX } from "../config";

export type RetrievalStrategy =
  | "jlss_only"
  | "jlss_then_zotero"
  | "zotero_then_jlss"
  | "zotero_only";

export const DEFAULT_RETRIEVAL_STRATEGY: RetrievalStrategy = "jlss_only";

export const RETRIEVAL_STRATEGY_OPTIONS: Array<{ value: RetrievalStrategy; label: string; description: string }> = [
  {
    value: "jlss_only",
    label: "全部使用聚联（默认）",
    description: "跳过 Zotero 内置全文搜索，所有缺少本地 PDF 的文献直接提交聚联。"
  },
  {
    value: "jlss_then_zotero",
    label: "聚联优先 → Zotero 后补",
    description: "先使用聚联；仅在聚联明确失败、提交失败或下载失败时再尝试 Zotero。"
  },
  {
    value: "zotero_then_jlss",
    label: "Zotero 优先 → 聚联后补",
    description: "先使用 Zotero Find Full Text；未找到时再提交聚联。"
  },
  {
    value: "zotero_only",
    label: "仅使用 Zotero",
    description: "只使用 Zotero 内置全文搜索，不向聚联提交任务。"
  }
];

export function getRetrievalStrategy(): RetrievalStrategy {
  const value = String(Zotero.Prefs.get(`${PREF_PREFIX}.retrievalStrategy`) || "").trim() as RetrievalStrategy;
  return RETRIEVAL_STRATEGY_OPTIONS.some(option => option.value === value)
    ? value
    : DEFAULT_RETRIEVAL_STRATEGY;
}

export function setRetrievalStrategy(value: RetrievalStrategy): void {
  if (!RETRIEVAL_STRATEGY_OPTIONS.some(option => option.value === value)) {
    throw new Error(`未知全文获取策略：${value}`);
  }
  Zotero.Prefs.set(`${PREF_PREFIX}.retrievalStrategy`, value);
}

export function retrievalStrategyLabel(value: RetrievalStrategy = getRetrievalStrategy()): string {
  return RETRIEVAL_STRATEGY_OPTIONS.find(option => option.value === value)?.label || value;
}
''')

# Queue entries remember the strategy used when enqueued.
replace(
    "src/core/QueueStore.ts",
    'import type { VerificationStatus } from "./PdfVerifier";\n',
    'import type { VerificationStatus } from "./PdfVerifier";\nimport type { RetrievalStrategy } from "./RetrievalStrategy";\n',
)
replace(
    "src/core/QueueStore.ts",
    "  source: QueueSource;\n  createdAt: string;\n",
    "  source: QueueSource;\n  retrievalStrategy?: RetrievalStrategy;\n  createdAt: string;\n",
)
replace(
    "src/core/QueueStore.ts",
    "      cancelNote: undefined\n",
    "      cancelNote: undefined,\n      retrievalStrategy: undefined\n",
)

# FlowEngine strategy routing.
replace(
    "src/core/FlowEngine.ts",
    'import { PdfVerifier } from "./PdfVerifier";\n',
    'import { PdfVerifier } from "./PdfVerifier";\nimport { getRetrievalStrategy } from "./RetrievalStrategy";\n',
)
replace(
    "src/core/FlowEngine.ts",
    '    const nativeFirst = this.prefBool(`${PREF_PREFIX}.nativeFirst`, true);\n',
    '    const strategy = getRetrievalStrategy();\n    const nativeFirst = strategy === "zotero_then_jlss" || strategy === "zotero_only";\n',
)
replace(
    "src/core/FlowEngine.ts",
    "      QueueStore.upsert(metadata);\n\n      if (nativeFirst) {\n",
    "      QueueStore.upsert(metadata);\n      QueueStore.patch(metadata.itemKey, metadata.libraryID, { retrievalStrategy: strategy });\n\n      if (nativeFirst) {\n",
)
replace(
    "src/core/FlowEngine.ts",
    '''        if (nativeResult.error) {
          QueueStore.patch(metadata.itemKey, metadata.libraryID, { nativeError: nativeResult.error });
        }
      }

      try {
''',
    '''        if (nativeResult.error) {
          QueueStore.patch(metadata.itemKey, metadata.libraryID, { nativeError: nativeResult.error });
        }
      }

      if (strategy === "zotero_only") {
        QueueStore.patch(metadata.itemKey, metadata.libraryID, {
          state: "failed",
          source: "zotero",
          diagnosticLevel: "info",
          diagnosticMessage: "当前策略为“仅使用 Zotero”；Zotero 未找到全文，因此未向聚联提交。",
          error: "Zotero 内置全文搜索未找到 PDF。可切换获取策略后重试。"
        });
        failed++;
        await this.delay(250);
        continue;
      }

      try {
''',
)
replace(
    "src/core/FlowEngine.ts",
    '''        else {
          QueueStore.patch(metadata.itemKey, metadata.libraryID, {
            state: "failed",
            source: "jlss",
            error: e instanceof Error ? e.message : String(e)
          });
          failed++;
        }
''',
    '''        else {
          const message = e instanceof Error ? e.message : String(e);
          if (strategy === "jlss_then_zotero") {
            const fallbackFound = await this.tryNativeFallback(item, metadata, `聚联提交失败：${message}`);
            if (fallbackFound) { native++; continue; }
          }
          QueueStore.patch(metadata.itemKey, metadata.libraryID, {
            state: "failed",
            source: "jlss",
            error: message
          });
          failed++;
        }
''',
)
replace(
    "src/core/FlowEngine.ts",
    '''        if (TASK_FAILED.has(record.taskStatus)) {
          QueueStore.patch(entry.itemKey, entry.libraryID, {
            state: "failed",
            diagnosticLevel: "warning",
            diagnosticMessage: `聚联远端明确返回失败/异常状态（status=${record.taskStatus}）。`,
            error: `聚联任务失败（status=${record.taskStatus}）`
          });
          continue;
        }
''',
    '''        if (TASK_FAILED.has(record.taskStatus)) {
          if (entry.retrievalStrategy === "jlss_then_zotero") {
            const fallbackFound = await this.tryNativeFallback(
              item,
              entry,
              `聚联远端明确返回失败/异常状态（status=${record.taskStatus}）`
            );
            if (fallbackFound) continue;
          }
          QueueStore.patch(entry.itemKey, entry.libraryID, {
            state: "failed",
            diagnosticLevel: "warning",
            diagnosticMessage: `聚联远端明确返回失败/异常状态（status=${record.taskStatus}）。`,
            error: `聚联任务失败（status=${record.taskStatus}）`
          });
          continue;
        }
''',
)
replace(
    "src/core/FlowEngine.ts",
    '''        catch (e) {
          QueueStore.patch(entry.itemKey, entry.libraryID, {
            state: "failed",
            diagnosticLevel: "warning",
            diagnosticMessage: "聚联已返回成功状态，但 PDF 下载或核验阶段失败。",
            error: e instanceof Error ? e.message : String(e)
          });
        }
''',
    '''        catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          if (entry.retrievalStrategy === "jlss_then_zotero") {
            const fallbackFound = await this.tryNativeFallback(
              item,
              entry,
              `聚联已返回成功状态，但 PDF 下载或核验失败：${message}`
            );
            if (fallbackFound) continue;
          }
          QueueStore.patch(entry.itemKey, entry.libraryID, {
            state: "failed",
            diagnosticLevel: "warning",
            diagnosticMessage: "聚联已返回成功状态，但 PDF 下载或核验阶段失败。",
            error: message
          });
        }
''',
)
replace(
    "src/core/FlowEngine.ts",
    "  cancelEntry(itemKey: string, libraryID: number): boolean {\n",
    '''  private async tryNativeFallback(
    item: any,
    entry: { itemKey: string; libraryID: number },
    reason: string
  ): Promise<boolean> {
    QueueStore.patch(entry.itemKey, entry.libraryID, {
      state: "native_search",
      diagnosticLevel: "info",
      diagnosticMessage: `${reason}；正在尝试 Zotero 后补。`
    });

    const nativeResult = await NativeFullText.tryFind(item);
    if (QueueStore.isCancelled(entry.itemKey, entry.libraryID)) {
      if (nativeResult.found && nativeResult.attachmentID) {
        QueueStore.patch(entry.itemKey, entry.libraryID, {
          source: "zotero",
          attachmentID: nativeResult.attachmentID,
          cancelNote: "任务已取消；取消生效前 Zotero 后补已获取全文，现有附件予以保留。"
        });
      }
      return Boolean(nativeResult.found);
    }

    if (!nativeResult.found) {
      QueueStore.patch(entry.itemKey, entry.libraryID, {
        nativeError: nativeResult.error,
        diagnosticLevel: "warning",
        diagnosticMessage: `${reason}；Zotero 后补也未找到全文。`
      });
      return false;
    }

    let verification: any = {
      status: "inconclusive",
      reason: "由 Zotero Find Full Text 后补获取，但未完成二次文本核验。"
    };
    try {
      const attachment: any = nativeResult.attachmentID ? Zotero.Items.get(nativeResult.attachmentID) : null;
      const current = QueueStore.find(entry.itemKey, entry.libraryID);
      if (attachment && current) verification = await PdfVerifier.verify(attachment, current);
    }
    catch (e) {
      verification = {
        status: "inconclusive",
        reason: `Zotero 后补已获取 PDF，但二次核验未完成：${e instanceof Error ? e.message : String(e)}`
      };
    }

    const state = verification.status === "review" ? "review" : "done";
    QueueStore.patch(entry.itemKey, entry.libraryID, {
      state,
      source: "zotero",
      attachmentID: nativeResult.attachmentID,
      verification: verification.status,
      verificationReason: verification.reason,
      nativeError: nativeResult.error,
      diagnosticLevel: state === "review" ? "warning" : null,
      diagnosticMessage: state === "review"
        ? `${reason}；Zotero 后补找到 PDF，但需要人工核对。`
        : `${reason}；Zotero 后补成功。`,
      error: state === "review" ? "Zotero 后补已获取 PDF，但身份核验未通过自动阈值，请人工核对。" : undefined
    });
    return true;
  }

  cancelEntry(itemKey: string, libraryID: number): boolean {
''',
)

# Menus: global radio strategy in Collection and Tools menus.
replace(
    "src/ui/Menus.ts",
    'import { TaskManager } from "./TaskManager";\n',
    'import { TaskManager } from "./TaskManager";\nimport { getRetrievalStrategy, RETRIEVAL_STRATEGY_OPTIONS, retrievalStrategyLabel, setRetrievalStrategy } from "../core/RetrievalStrategy";\n',
)
replace(
    "src/ui/Menus.ts",
    '      "fulltextflow-tools-status", "fulltextflow-tools-tasks"\n',
    '      "fulltextflow-tools-status", "fulltextflow-tools-tasks", "fulltextflow-tools-strategy"\n',
)
replace(
    "src/ui/Menus.ts",
    '''      const result = await this.engine.enqueueItems(selected);
      Services.prompt.alert(
''',
    '''      const strategyLabel = retrievalStrategyLabel();
      const result = await this.engine.enqueueItems(selected);
      Services.prompt.alert(
''',
)
replace(
    "src/ui/Menus.ts",
    '        `Zotero 直接找到 ${result.native} 篇；提交聚联 ${result.queued} 篇；等待登录 ${result.waitingAuth} 篇；跳过 ${result.skipped} 篇；失败 ${result.failed} 篇。`\n',
    '        `获取策略：${strategyLabel}\\nZotero 获取 ${result.native} 篇；提交聚联 ${result.queued} 篇；等待登录 ${result.waitingAuth} 篇；跳过 ${result.skipped} 篇；失败 ${result.failed} 篇。`\n',
)
replace(
    "src/ui/Menus.ts",
    '''    auto.addEventListener("command", () => this.toggleAuto(win));
    const login = this.menuItem(win, "聚联登录/刷新登录", () => AuthWindow.open(win, this.engine));
''',
    '''    auto.addEventListener("command", () => this.toggleAuto(win));
    const strategy = this.strategyMenu(win, "全文获取策略", "fulltextflow-collection-strategy");
    const login = this.menuItem(win, "聚联登录/刷新登录", () => AuthWindow.open(win, this.engine));
''',
)
replace(
    "src/ui/Menus.ts",
    "    menupopup.append(current, recursive, auto, login, tasks, poll);\n",
    "    menupopup.append(current, recursive, auto, strategy, login, tasks, poll);\n",
)
replace(
    "src/ui/Menus.ts",
    '    const tasks = this.menuItem(win, "FullTextFlow 任务管理", () => TaskManager.open(win, this.engine));\n',
    '    const strategy = this.strategyMenu(win, "FullTextFlow 全文获取策略", "fulltextflow-tools-strategy");\n    const tasks = this.menuItem(win, "FullTextFlow 任务管理", () => TaskManager.open(win, this.engine));\n',
)
replace(
    "src/ui/Menus.ts",
    "    popup.append(login, settings, token, tasks, status);\n",
    "    popup.append(login, settings, token, strategy, tasks, status);\n",
)
replace(
    "src/ui/Menus.ts",
    "  private menuItem(win: any, label: string, fn?: () => void | Promise<void>) {\n",
    '''  private strategyMenu(win: any, label: string, id: string) {
    const menu = win.document.createXULElement("menu");
    menu.id = id;
    menu.setAttribute("label", label);
    const popup = win.document.createXULElement("menupopup");
    const group = `${id}-radio-group`;

    for (const option of RETRIEVAL_STRATEGY_OPTIONS) {
      const item = win.document.createXULElement("menuitem");
      item.setAttribute("type", "radio");
      item.setAttribute("name", group);
      item.setAttribute("value", option.value);
      item.setAttribute("label", option.label);
      item.setAttribute("tooltiptext", option.description);
      item.addEventListener("command", () => {
        setRetrievalStrategy(option.value);
        Services.prompt.alert(win, PLUGIN_NAME, `全文获取策略已切换为：${option.label}\n\n${option.description}`);
      });
      popup.append(item);
    }

    popup.addEventListener("popupshowing", () => {
      const current = getRetrievalStrategy();
      for (const item of Array.from(popup.children) as any[]) {
        item.setAttribute("checked", item.getAttribute("value") === current ? "true" : "false");
      }
    });
    menu.append(popup);
    return menu;
  }

  private menuItem(win: any, label: string, fn?: () => void | Promise<void>) {
''',
)
replace(
    "src/ui/Menus.ts",
    '    const nativeFirst = this.prefBool(`${PREF_PREFIX}.nativeFirst`, true);\n    const summary = [\n',
    '    const strategy = getRetrievalStrategy();\n    const strategyLabel = retrievalStrategyLabel(strategy);\n    const summary = [\n',
)
replace(
    "src/ui/Menus.ts",
    '      `获取顺序：${nativeFirst ? "Zotero Find Full Text → 聚联" : "聚联"}`\n',
    '      `获取策略：${strategyLabel}`\n',
)
replace(
    "src/ui/Menus.ts",
    '      `处理完成：Zotero 直接找到 ${result.native} 篇；提交聚联 ${result.queued} 篇；等待登录 ${result.waitingAuth} 篇；跳过 ${result.skipped} 篇；失败 ${result.failed} 篇。\\n聚联任务会在后台自动检查。`\n',
    '      `获取策略：${strategyLabel}\\n处理完成：Zotero 获取 ${result.native} 篇；提交聚联 ${result.queued} 篇；等待登录 ${result.waitingAuth} 篇；跳过 ${result.skipped} 篇；失败 ${result.failed} 篇。\\n聚联任务会在后台自动检查。`\n',
)
replace(
    "src/ui/Menus.ts",
    '    const hasCredentials = await AuthManager.hasCredentials();\n    const lines = Object.entries(counts).map(([k,v]) => `${k}: ${v}`);\n',
    '    const hasCredentials = await AuthManager.hasCredentials();\n    const strategyLabel = retrievalStrategyLabel();\n    const lines = Object.entries(counts).map(([k,v]) => `${k}: ${v}`);\n',
)
replace(
    "src/ui/Menus.ts",
    '      `聚联 token：${hasToken ? "已保存" : "未登录"}\\n自动登录凭证：${hasCredentials ? "已保存" : "未设置"}\\n当前活动任务：${active}\\n\\n${lines.join("\\n") || "暂无任务"}`\n',
    '      `全文获取策略：${strategyLabel}\\n聚联 token：${hasToken ? "已保存" : "未登录"}\\n自动登录凭证：${hasCredentials ? "已保存" : "未设置"}\\n当前活动任务：${active}\\n\\n${lines.join("\\n") || "暂无任务"}`\n',
)

# Defaults/build/version.
replace(
    "addon/prefs.js",
    'pref("extensions.zotero.fullTextFlow.nativeFirst", true);\n',
    'pref("extensions.zotero.fullTextFlow.retrievalStrategy", "jlss_only");\n',
)
replace(
    "scripts/build_local.py",
    '    "src/core/Metadata.ts",\n',
    '    "src/core/Metadata.ts",\n    "src/core/RetrievalStrategy.ts",\n',
)

pkg = json.loads(Path("package.json").read_text())
pkg["version"] = "0.2.7"
pkg["description"] = "Collection-scoped full-text completion for Zotero with configurable Zotero/JLSS retrieval strategies, dual web/API session verification, remote-task diagnostics, cancellation controls, stable task-table UI, verification, and secure authentication."
Path("package.json").write_text(json.dumps(pkg, ensure_ascii=False, indent=2) + "\n")

p = Path("README.md")
readme = p.read_text()
readme = readme.replace("**Current preview: 0.2.6**", "**Current preview: 0.2.7**")
readme = readme.replace("## Current version: 0.2.6 Preview", "## Current version: 0.2.7 Preview")
marker = "## Retrieval order\n"
strategy_section = '''## Full-text retrieval strategy

Starting with **0.2.7**, FullTextFlow uses a global retrieval strategy shared by manual Collection runs, recursive runs, item-context actions, automatic Collection fetching, and retries.

Available modes:

1. **全部使用聚联（默认）** — skip Zotero Find Full Text and send every item missing a usable local PDF directly to JLSS.
2. **聚联优先 → Zotero 后补** — use JLSS first; only if JLSS submission fails (non-auth), the remote task explicitly fails/errors, or PDF download/import fails does Zotero Find Full Text run as a fallback. Normal JLSS/manual processing is allowed to continue without duplicate retrieval.
3. **Zotero 优先 → 聚联后补** — use Zotero Find Full Text first and submit to JLSS only when Zotero does not find a PDF.
4. **仅使用 Zotero** — never submit a JLSS task.

The strategy can be changed from either **Tools → FullTextFlow 全文获取策略** or the selected Collection's **FullTextFlow → 全文获取策略** submenu. Changing the global preference affects newly enqueued/retried work; an already-active JLSS task keeps the strategy recorded when it was submitted and is not rerouted mid-flight. Existing usable local PDFs are always skipped in every mode.

'''
if strategy_section not in readme:
    readme = readme.replace(marker, strategy_section + marker)
readme = readme.replace(
    "- secure/browser-assisted JLSS authentication;\n",
    "- configurable four-mode Zotero/JLSS retrieval strategy (JLSS-only default);\n- secure/browser-assisted JLSS authentication;\n",
)
p.write_text(readme)

p = Path("CHANGELOG.md")
changelog = p.read_text()
entry = '''## 0.2.7 - 2026-08-28

- Added a global four-mode full-text retrieval strategy shared by manual Collection runs, recursive runs, item-context actions, automatic Collection fetching, and retries.
- Changed the default strategy to **全部使用聚联** (`jlss_only`), matching the primary workflow preference for direct JLSS retrieval.
- Added **聚联优先 → Zotero 后补** (`jlss_then_zotero`): Zotero is only attempted after non-auth JLSS submission failure, explicit remote failure/error, or PDF download/import failure; normal JLSS/manual processing does not trigger duplicate fallback retrieval.
- Retained **Zotero 优先 → 聚联后补** (`zotero_then_jlss`) as the former behavior and added **仅使用 Zotero** (`zotero_only`).
- Added mutually exclusive strategy radio menus under both Tools and Collection FullTextFlow menus.
- Each queue entry records the strategy used at enqueue time so changing the global setting does not reroute already-active JLSS work.
- Batch confirmation, result summaries, and task overview now show the current retrieval strategy.
- Replaced the legacy `nativeFirst` default with `retrievalStrategy`.
- Preserved acknowledgement of the prior-art/reference project `HiYvri/pdf-fetcher`.

'''
if not changelog.startswith("# Changelog\n\n## 0.2.7"):
    changelog = changelog.replace("# Changelog\n\n", "# Changelog\n\n" + entry, 1)
p.write_text(changelog)
