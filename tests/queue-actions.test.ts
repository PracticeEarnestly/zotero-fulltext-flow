import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

// Run the production queue/engine with in-memory Zotero prefs and fake network/PDF services.
// No user profile, attachments, credentials, or JLSS endpoints are touched.
function setup(initial: any[], options: any = {}) {
  const prefs = new Map<string, any>([["test.queue", JSON.stringify(initial)], ["test.maxBatch", options.maxBatch || 50]]);
  const submitted: string[] = [];
  const metadata = (entry: any) => ({ ...entry, queryText: entry.title || entry.itemKey, isRegularItem: () => true });
  const items = new Map(initial.map(entry => [entry.itemID, metadata(entry)]));
  const sandbox: any = {
    PREF_PREFIX: "test", TASK_FAILED: new Set(["3", "6"]), TASK_SUCCESS: "2",
    Zotero: { Prefs: { get: (key: string) => prefs.get(key), set: (key: string, value: any) => prefs.set(key, value) }, Items: { get: (id: number) => items.get(id) } },
    hasUsablePDF: async (item: any) => Boolean(options.hasPDF?.(item)),
    extractItemMetadata: metadata,
    getRetrievalStrategy: () => "jlss_only",
    JLSSAuthRequiredError: class extends Error {},
    JLSSClient: { submit: async (entry: any) => { submitted.push(entry.itemKey); await options.submit?.(entry); }, listAllTasks: async () => [] },
    PdfVerifier: { verify: async () => ({ status: options.verification || "verified", reason: "test verification" }) },
    IOUtils: { exists: async (path: string) => path === "existing.pdf" },
    setTimeout: () => 0, clearInterval: () => {}, setInterval: () => 0,
  };
  const source = ["src/core/QueueStates.ts", "src/core/QuotaRetry.ts", "src/core/QueueStore.ts", "src/core/FlowEngine.ts"]
    .map(path => readFileSync(new URL(`../${path}`, import.meta.url), "utf8").replace(/^import .*$/gm, "").replace(/^export /gm, ""))
    .join("\n");
  const code = ts.transpileModule(source + "\nglobalThis.store = QueueStore; globalThis.Engine = FlowEngine;", { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  vm.runInNewContext(code, sandbox);
  const engine = new sandbox.Engine();
  engine.delay = async () => {};
  return { store: sandbox.store, engine, submitted, items, prefs, sandbox };
}
const entry = (itemKey: string, state: string, libraryID = 1, extra: any = {}) => ({ itemKey, libraryID, itemID: itemKey.charCodeAt(0) + libraryID * 100, title: itemKey, state, createdAt: "2026-10-25T00:00:00Z", ...extra });

test("retry submits only selected failed/stopped tasks instead of skipping reset queued entries", async () => {
  const records = [entry("A", "failed"), entry("B", "cancelled"), entry("C", "failed"), entry("D", "review"), entry("E", "pending")];
  const { store, engine, submitted } = setup(records);
  const result = await engine.retryProblemEntries([records[0], records[1], records[3], records[4]]);
  assert.deepEqual(submitted, ["A", "B"]);
  assert.equal(result.queued, 2);
  assert.equal(store.find("C", 1).state, "failed");
  assert.equal(store.find("D", 1).state, "review");
  assert.equal(store.find("E", 1).state, "pending");
});

test("retry preserves excess batch entries and reports skipped usable PDFs", async () => {
  const records = [entry("A", "failed"), entry("B", "failed"), entry("C", "failed")];
  const { store, engine, submitted } = setup(records, { maxBatch: 1, hasPDF: (item: any) => item.itemKey === "A" });
  const result = await engine.retryProblemEntries(records);
  assert.deepEqual(submitted, ["B"]);
  assert.equal(result.skipped, 2);
  assert.equal(store.find("C", 1).state, "failed");
});

test("removal scopes to exact library/key and protects active/review rows", () => {
  const records = [entry("A", "failed"), entry("A", "failed", 2), entry("B", "done"), entry("C", "pending"), entry("D", "review")];
  const { store } = setup(records);
  assert.equal(store.clearSelected([records[0], records[2], records[3], records[4]]), 2);
  assert.equal(store.find("A", 2).state, "failed");
  assert.equal(store.find("C", 1).state, "pending");
  assert.equal(store.find("D", 1).state, "review");
});

test("late completions and errors cannot reactivate a cancelled task; explicit retry can", () => {
  const { store } = setup([entry("A", "pending")]);
  store.cancel("A", 1);
  for (const state of ["pending", "failed", "waiting_auth", "done"]) {
    store.patch("A", 1, { state });
    assert.equal(store.find("A", 1).state, "cancelled");
  }
  store.resetForRetry("A", 1);
  assert.equal(store.find("A", 1).state, "queued");
});

test("cancellation during submission survives a late rejection", async () => {
  let store: any;
  const record = entry("A", "failed");
  const env = setup([record], { submit: async () => { store.cancel("A", 1); throw new Error("late network failure"); } });
  store = env.store;
  await env.engine.retryProblemEntries([record]);
  assert.equal(store.find("A", 1).state, "cancelled");
});

test("login resumes remote submissions without creating duplicate requests", async () => {
  const records = [entry("A", "waiting_auth", 1, { submittedAt: "2026-10-25T00:00:00Z" }), entry("B", "waiting_auth")];
  const { store, engine, submitted } = setup(records);
  let polls = 0;
  engine.poll = async () => { polls++; };
  await engine.resumeAuthWaiting();
  assert.deepEqual(submitted, ["B"]);
  assert.equal(store.find("A", 1).state, "submitted");
  assert.equal(polls, 1);
});

test("poll does not treat unsubmitted or login-blocked rows as remote work", async () => {
  const { store, engine, sandbox } = setup([entry("A", "queued", 1, { source: "jlss" }), entry("B", "waiting_auth", 1, { source: "jlss" })]);
  sandbox.JLSSClient.listAllTasks = async () => { throw new Error("must not call remote"); };
  await engine.poll();
  assert.equal(store.find("A", 1).state, "queued");
  assert.equal(store.find("B", 1).state, "waiting_auth");
});

test("recheck never resubmits or marks inconclusive review PDFs as verified", async () => {
  const records = [entry("A", "review", 1, { attachmentID: 999 }), entry("B", "failed")];
  const { store, engine, submitted, items } = setup(records, { verification: "inconclusive" });
  items.set(999, { id: 999 });
  const result = await engine.recheckSelected(records);
  assert.equal(result.review, 1);
  assert.equal(store.find("A", 1).state, "review");
  assert.equal(store.find("B", 1).state, "failed");
  assert.deepEqual(submitted, []);
});

test("recheck confirms verified PDFs and preserves review on missing attachment", async () => {
  const records = [entry("A", "review", 1, { attachmentID: 999 }), entry("B", "review")];
  const { store, engine, items } = setup(records);
  items.set(999, { id: 999 });
  const result = await engine.recheckSelected(records);
  assert.equal(result.verified, 1);
  assert.equal(result.review, 1);
  assert.equal(store.find("A", 1).state, "done");
  assert.equal(store.find("B", 1).state, "review");
  assert.match(store.find("B", 1).verificationReason, /附件已不存在/);
});

test("manual confirmation is distinct from automatic verification and requires a local attachment", async () => {
  const records = [entry("A", "review", 1, { attachmentID: 999 }), entry("B", "review"), entry("C", "failed")];
  const { store, engine, items, submitted } = setup(records);
  items.set(999, { getFilePathAsync: async () => "existing.pdf" });
  const result = await engine.confirmReviewed(records);
  assert.equal(result.confirmed, 1);
  assert.equal(result.missing, 1);
  assert.equal(store.find("A", 1).state, "done");
  assert.equal(store.find("A", 1).verification, "manual");
  assert.equal(store.find("B", 1).state, "review");
  assert.equal(store.find("C", 1).state, "failed");
  assert.deepEqual(submitted, []);
});

test("quota exhaustion retains remaining batch and prevents repeated submissions", async () => {
  const records = [entry("A", "failed"), entry("B", "failed"), entry("C", "failed")];
  const { store, engine, submitted, prefs } = setup(records, { submit: async () => { throw new Error("当日传递次数已达上限"); } });
  const result = await engine.retryProblemEntries(records);
  assert.deepEqual(submitted, ["A"]);
  assert.equal(result.waitingQuota, 3);
  assert.equal(result.failed, 0);
  for (const record of records) {
    const saved = store.find(record.itemKey, 1);
    assert.equal(saved.state, "waiting_quota");
    assert.ok(Date.parse(saved.retryAfter) > Date.now());
    assert.equal(saved.retryAfter, prefs.get("test.quotaRetryAfter"));
  }
  await engine.resumeQuotaWaiting();
  assert.deepEqual(submitted, ["A"]);
});

test("persisted overdue quota work resumes after restart, respects batch limit and ignores stopped work", async () => {
  const past = "2020-01-01T00:10:00Z";
  const records = [entry("A", "waiting_quota", 1, { retryAfter: past }), entry("B", "waiting_quota", 1, { retryAfter: past }), entry("C", "cancelled", 1, { retryAfter: past })];
  const { store, engine, submitted } = setup(records, { maxBatch: 1 });
  await engine.resumeQuotaWaiting();
  assert.deepEqual(submitted, ["A"]);
  assert.equal(store.find("B", 1).state, "waiting_quota");
  await engine.resumeQuotaWaiting();
  assert.deepEqual(submitted, ["A", "B"]);
  assert.equal(store.find("C", 1).state, "cancelled");
});

test("repeated quota exhaustion postpones all waiting rows even beyond current batch", async () => {
  const records = ["A", "B"].map(key => entry(key, "waiting_quota", 1, { retryAfter: "2020-01-01T00:10:00Z" }));
  const { store, engine, submitted } = setup(records, { maxBatch: 1, submit: async () => { throw new Error("当日传递次数已达上限"); } });
  await Promise.all([engine.resumeQuotaWaiting(), engine.resumeQuotaWaiting()]);
  assert.deepEqual(submitted, ["A"]);
  assert.ok(Date.parse(store.find("B", 1).retryAfter) > Date.now());
  assert.equal(store.find("A", 1).retryAfter, store.find("B", 1).retryAfter);
});

test("only selected legacy quota failures without remote submissions can be scheduled", () => {
  const records = [entry("A", "failed", 1, { error: "当日传递次数已达上限" }), entry("B", "failed", 1, { error: "network error" }), entry("C", "failed", 1, { error: "当日传递次数已达上限", taskCode: "remote" }), entry("D", "failed", 1, { error: "当日传递次数已达上限" })];
  const { store, engine } = setup(records);
  assert.equal(engine.scheduleQuotaSelected(records.slice(0, 3)), 1);
  assert.equal(store.find("A", 1).state, "waiting_quota");
  assert.equal(store.clearSelected(records), 3);
  assert.equal(store.find("A", 1).state, "waiting_quota");
  store.cancel("A", 1);
  assert.equal(store.find("A", 1).retryAfter, undefined);
});

test("automatic quota resume skips existing PDFs and stops missing items without requests", async () => {
  const records = ["A", "B"].map(key => entry(key, "waiting_quota", 1, { retryAfter: "2020-01-01T00:10:00Z" }));
  const { store, engine, submitted, items } = setup(records, { hasPDF: (item: any) => item.itemKey === "A" });
  items.delete(records[1].itemID);
  await engine.resumeQuotaWaiting();
  assert.deepEqual(submitted, []);
  assert.equal(store.find("A", 1).state, "done");
  assert.equal(store.find("B", 1).state, "failed");
});

test("serialized batches share quota backoff", async () => {
  const records = [entry("A", "failed"), entry("B", "failed")];
  const { engine, store, submitted } = setup(records, { submit: async () => { throw new Error("当日传递次数已达上限"); } });
  await Promise.all(records.map(record => engine.retryProblemEntries([record])));
  assert.deepEqual(submitted, ["A"]);
  assert.equal(store.find("B", 1).state, "waiting_quota");
});
