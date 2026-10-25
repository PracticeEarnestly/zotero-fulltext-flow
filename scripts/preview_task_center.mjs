// Isolated browser preview of the production task UI. No Zotero profile/network access.
// Run: node scripts/preview_task_center.mjs
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
const root = new URL("../addon/content/", import.meta.url);
const states = ["failed", "pending", "waiting_auth", "review", "done", "cancelled"];
const rows = states.map((state, index) => ({
  itemKey: `DEMO${index}`, libraryID: 1, state,
  title: ["2026 Guideline for the management of inflammatory arthritis", "Recommendations for vaccination in adults with autoimmune inflammatory rheumatic diseases", "Clinical practice guideline: diagnosis and management", "Systematic review of long-term treatment outcomes", "Evidence-based recommendations for disease monitoring", "Imaging recommendations in large vessel vasculitis"][index],
  source: "jlss", updatedAt: "2026-10-25T01:00:00Z", createdAt: "2026-10-24T12:00:00Z",
  reason: state === "failed" ? "当日传递次数已达上限" : state === "review" ? "PDF 已下载，但标题匹配较低，请核对附件。" : "",
  canCancel: ["pending", "waiting_auth"].includes(state),
  canRetry: ["failed", "cancelled"].includes(state),
  canScheduleQuota: state === "failed",
  canClear: ["failed", "done", "cancelled"].includes(state), canRecheck: state === "review"
}));
createServer((request, response) => {
  if (request.url === "/task-manager.js") {
    response.setHeader("Content-Type", "text/javascript; charset=utf-8");
    response.end(readFileSync(new URL("task-manager.js", root)));
    return;
  }
  if (request.url !== "/") { response.writeHead(404); response.end(); return; }
  const source = readFileSync(new URL("task-manager.xhtml", root), "utf8");
  const style = source.match(/<html:style><!\[CDATA\[([\s\S]*?)\]\]><\/html:style>/)[1];
  const body = source.slice(source.indexOf("  <vbox"), source.lastIndexOf("</window>"))
    .replace(/html:/g, "").replace(/<vbox\b[^>]*>/g, '<main class="window">').replace(/<\/vbox>/g, "</main>")
    .replace(/<hbox\b[^>]*>/g, '<div class="toolbar">').replace(/<\/hbox>/g, "</div>")
    .replace(/<spacer[^>]*\/>/g, "")
    .replace(/<description([^>]*)\/>/g, "<div$1></div>")
    .replace(/<description/g, "<div").replace(/<\/description>/g, "</div>")
    .replace(/<button id="close" label="关闭"\/>/, '<button id="close">关闭</button>')
    .replace(/<tbody([^>]*)\/>/g, "<tbody$1></tbody>")
    .replace(/<div([^>]*)\/>/g, "<div$1></div>");
  const bridge = `
    let rows = ${JSON.stringify(rows)};
    const key = r => r.libraryID + ':' + r.itemKey;
    window.arguments = [{wrappedJSObject: {
      getRows: () => rows, getOverview: async () => ({strategyLabel:'聚联优先 → Zotero 后补',hasToken:true}),
      poll: async () => {}, openLogin: () => alert('演示：打开聚联登录'), locate: () => alert('演示：定位 Zotero 条目'),
      clearSelected: targets => { const keys = new Set(targets.map(key)); const before = rows.length; rows = rows.filter(r => !keys.has(key(r)) || !r.canClear); return before - rows.length; },
      cancelOne: (itemKey, libraryID) => {const row = rows.find(r => r.itemKey === itemKey && r.libraryID === libraryID); if(!row?.canCancel)return false; Object.assign(row,{state:'cancelled',canCancel:false,canRetry:true,canClear:true});return true;},
      retrySelected: async targets => ({queued:targets.length,native:0,failed:0,waitingAuth:0,skipped:0}),
      recheckSelected: async targets => ({verified:0,review:targets.length}),
      confirmReviewed: async targets => ({confirmed:targets.length,missing:0}),
      scheduleQuotaSelected: targets => { const keys = new Set(targets.map(key)); const date = new Date(); date.setDate(date.getDate()+1); date.setHours(0,10,0,0); let count=0; for(const row of rows) if(keys.has(key(row)) && row.canScheduleQuota) {Object.assign(row,{state:'waiting_quota',canCancel:true,canRetry:false,canClear:false,canScheduleQuota:false,retryAfter:date.toISOString()});count++;} return count; }
    }}];`;
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.end(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>FullTextFlow 隔离预览</title><style>${style}
    body{margin:0;font:13px system-ui;background:#fafafa;color:#222}.window{padding:16px;min-width:920px;display:flex;flex-direction:column;height:calc(100vh - 32px)}
    #table-wrap{min-height:240px}#tasks-table{font-family:system-ui}#tasks-table th{background:#f0f1f3}button{cursor:pointer}button:disabled{cursor:default}
  </style><script>${bridge}</script><script src="/task-manager.js"></script></head><body>${body}</body></html>`);
}).listen(8765, "127.0.0.1", () => console.log("Isolated task center preview: http://127.0.0.1:8765"));
