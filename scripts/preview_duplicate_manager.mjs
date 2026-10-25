// Fictional, in-memory UI preview. Never reads a Zotero profile or modifies PDFs.
// Run: node scripts/preview_duplicate_manager.mjs
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
const root = new URL("../addon/content/", import.meta.url);
const groups = [1, 2, 3].map(id => ({
  id: `demo-${id}`, parentID: id,
  title: id === 1 ? "Recommendations for the management of inflammatory arthritis — demo" : id === 2 ? "同一条目下的三个全文附件（含批注保护演示）" : "含不同附件笔记的 PDF（人工核对演示）",
  files: [1, 2, ...(id === 2 ? [3] : [])].map(index => ({
    id: id * 10 + index, key: `DEMO${id}${index}`, title: index === 1 ? "Full Text PDF" : "Publisher Full Text",
    path: `/demo/storage/DEMO${id}${index}/inflammatory-arthritis-full-text.pdf`, size: 3829012,
    hash: (id === 1 ? "37af0c21" : "9f2a315b").repeat(8),
    annotations: id === 2 && index < 3 ? (index === 1 ? 5 : 3) : 0, notes: id === 3 ? 1 : 0, mergeReason: id === 3 ? "附件带笔记，请人工处理" : "",
    protectedReason: id === 3 ? "附件带笔记，请人工处理" : id === 2 && index < 3 ? "有批注或笔记（包括回收站中的），请人工处理" : ""
  }))
}));
createServer((request, response) => {
  if (request.url === "/duplicate-manager.js") {
    response.setHeader("Content-Type", "text/javascript; charset=utf-8");
    response.end(readFileSync(new URL("duplicate-manager.js", root))); return;
  }
  if (request.url !== "/") { response.writeHead(404); response.end(); return; }
  const source = readFileSync(new URL("duplicate-manager.xhtml", root), "utf8");
  const style = source.match(/<html:style><!\[CDATA\[([\s\S]*?)\]\]><\/html:style>/)[1];
  const body = source.slice(source.indexOf(" <vbox"), source.lastIndexOf("</window>"))
    .replace(/html:/g, "").replace(/<vbox\b[^>]*>/, '<main class="window">').replace(/<\/vbox>/, "</main>")
    .replace(/<description/g, "<div").replace(/<\/description>/g, "</div>")
    .replace(/<(div|pre)([^>]*)\/>/g, "<$1$2></$1>");
  const bridge = `
    let groups = ${JSON.stringify(groups)};
    const records = [];
    let batchID = 'demo-batch';
    window.arguments = [{wrappedJSObject: {
      beginBatch: () => { batchID = 'demo-batch-' + Date.now(); },
      notes: async id => groups.find(g => g.id === id).files.map((f, i) => ({key:f.key, title:f.title,
        notes:f.notes ? [{key:f.key, deleted:false, html: '<p>共同阅读记录</p><p>' + (i ? '补充：需要核对随访时间。' : '重点：核对纳入标准。') + '</p>'}] : []})),
      scopeLabel: '隔离演示资料库（虚构数据）', selectedCount: 2,
      scan: async () => ({groups: structuredClone(groups), checked: 3, skipped: []}), cancel: () => {},
      open: () => alert('演示：打开 PDF，未访问真实文件'), locate: () => alert('演示：定位条目'),
      history: async () => records,
      merge: async (id, keeper, ids, answer) => {
        if(answer !== '合并批注并清理' || ids.includes(keeper)) throw new Error('未确认');
        const group = groups.find(g => g.id === id), backup = structuredClone(group);
        const count = group.files.filter(f => ids.includes(f.id)).reduce((sum,f) => sum+f.annotations,0);
        group.files.find(f=>f.id===keeper).annotations += count;
        group.files = group.files.filter(f => !ids.includes(f.id));
        groups = groups.filter(g => g.files.length > 1);
        records.unshift({id: 'demo-' + records.length, batchID, kind:'merge', createdAt:new Date().toISOString(), title:group.title,
          status:'committed',annotations:count,copies:ids.length,backup});
        return {moved:ids.length,annotations:count,warning:''};
      },
      restore: async (id, answer) => {
        if(answer !== '恢复操作') throw new Error('未确认');
        const record=records.find(r=>r.id===id); groups=groups.filter(g=>g.id!==record.backup.id);
        groups.push(structuredClone(record.backup)); record.status='restored';
        return '演示：已恢复附件并将批注移回原附件；未访问真实资料库。';
      },
      trash: async (id, keeper, ids, answer) => {
        if (answer !== '移入回收站' || ids.includes(keeper)) throw new Error('未确认或保留选择有误');
        const group = groups.find(group => group.id === id);
        if (!group || ids.some(id => !group.files.some(f => f.id === id && !f.protectedReason))) throw new Error('受保护的附件');
        records.unshift({id:'demo-' + records.length, batchID, kind:'trash', createdAt:new Date().toISOString(), title:group.title,
          status:'committed',annotations:0,copies:ids.length,backup:structuredClone(group)});
        group.files = group.files.filter(file => !ids.includes(file.id));
        groups = groups.filter(group => group.files.length > 1); return {moved:ids.length,warning:''};
      }
    }}];`;
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.end(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>重复 PDF · 隔离预览</title><style>${style}
    body{margin:0;font:13px system-ui;background:#f7f8fa;color:#222}.window{padding:16px;min-width:800px;display:flex;flex-direction:column;height:calc(100vh - 32px)}
    #groups{border-block:1px solid #ddd}.group{background:white;border-color:#ddd}td,th{border-color:#ddd}button{cursor:pointer}button:disabled{cursor:default}
  </style><script>${bridge}</script><script src="/duplicate-manager.js"></script></head><body>${body}</body></html>`);
}).listen(8766, "127.0.0.1", () => console.log("Isolated duplicate preview: http://127.0.0.1:8766"));
