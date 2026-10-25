import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

// Minimal DOM adapter for exercising the actual event handlers without a Zotero profile.
class Element {
  children: Element[] = [];
  events = new Map<string, Function>();
  dataset: any = {};
  attributes: any = {};
  classes = new Set<string>();
  classList = { toggle: (name: string, value: boolean) => value ? this.classes.add(name) : this.classes.delete(name) };
  textContent = "";
  value = "";
  checked = false;
  disabled = false;
  hidden = false;
  options: any[] = [];
  append(...children: Element[]) { this.children.push(...children); }
  appendChild(child: Element) { this.append(child); }
  replaceChildren() { this.children = []; }
  setAttribute(key: string, value: string) { this.attributes[key] = value; }
  addEventListener(name: string, handler: Function) { this.events.set(name, handler); }
  async fire(name: string) { await this.events.get(name)?.({ currentTarget: this }); }
}
const fixture = (key: string, state: string, extra = {}) => ({
  itemKey: key, libraryID: 1, title: key, state,
  canCancel: ["queued", "submitted", "pending", "waiting_auth", "waiting_quota"].includes(state),
  canRetry: ["failed", "cancelled"].includes(state), canClear: ["done", "failed", "cancelled"].includes(state),
  canRecheck: state === "review", ...extra
});
async function setup(rows: any[]) {
  const markup = readFileSync(new URL("../addon/content/task-manager.xhtml", import.meta.url), "utf8");
  const elements = new Map([...markup.matchAll(/\bid="([^"]+)"/g)].map(match => [match[1], new Element()]));
  const get = (id: string) => elements.get(id)!;
  get("filter").options = ["all", "active", "waiting_auth", "waiting_quota", "failed", "review", "done", "cancelled"].map(value => ({ value, textContent: "" }));
  get("filter").value = "all";
  const calls: any[] = [];
  const api = {
    getRows: () => rows, getOverview: async () => ({ strategyLabel: "聚联", hasToken: true }),
    clearSelected: (targets: any) => { calls.push(["clear", targets]); return targets.length; },
    retrySelected: async (targets: any) => { calls.push(["retry", targets]); return { queued: targets.length, native: 0, failed: 0, skipped: 0, waitingAuth: 0 }; },
    recheckSelected: async (targets: any) => { calls.push(["recheck", targets]); return { verified: 0, review: targets.length }; },
    confirmReviewed: async (targets: any) => { calls.push(["confirmReviewed", targets]); return { confirmed: targets.length, missing: 0 }; },
    scheduleQuotaSelected: (targets: any) => { calls.push(["scheduleQuota", targets]); return targets.length; },
    cancelOne: (itemKey: string, libraryID: number) => { calls.push(["cancel", { itemKey, libraryID }]); return true; },
    locate: async () => {}, poll: async () => {}, openLogin: async () => {}
  };
  const listeners = new Map<string, Function>();
  const window: any = {
    arguments: [{ wrappedJSObject: api }], addEventListener: (event: string, fn: Function) => listeners.set(event, fn),
    setInterval: () => 1, clearInterval: () => {}, confirm: () => true, prompt: () => null
  };
  vm.runInNewContext(readFileSync(new URL("../addon/content/task-manager.js", import.meta.url), "utf8"), {
    window, document: { getElementById: get, createElementNS: () => new Element() }
  });
  await listeners.get("load")!();
  await window.FullTextFlowTasks.refresh();
  return {
    get, calls, api, window,
    async filter(value: string) { get("filter").value = value; await get("filter").fire("change"); },
    async selectAll() { get("select-all").checked = true; await get("select-all").fire("change"); }
  };
}

test("filter/select-all scopes removal; cancelling or mistyping confirmation does not mutate", async () => {
  const ui = await setup([fixture("A", "failed"), fixture("B", "done"), fixture("C", "review"), fixture("D", "pending")]);
  await ui.filter("failed");
  await ui.selectAll();
  assert.equal(ui.get("retry").textContent, "重新获取（1）");
  assert.equal(ui.get("cancel-selected").disabled, true);
  for (const answer of [null, "", "确认", "清"]) {
    ui.window.prompt = () => answer;
    await ui.get("clear-selected").fire("click");
    assert.equal(ui.calls.length, 0);
  }
  ui.window.prompt = () => "清理";
  await ui.get("clear-selected").fire("click");
  assert.equal(JSON.stringify(ui.calls), JSON.stringify([["clear", [{ itemKey: "A", libraryID: 1 }]]]));
});

test("mixed selection gives each action only eligible tasks", async () => {
  const ui = await setup([fixture("A", "failed"), fixture("B", "cancelled"), fixture("C", "review"), fixture("D", "pending"), fixture("E", "done")]);
  await ui.selectAll();
  await ui.get("retry").fire("click");
  await ui.get("recheck").fire("click");
  await ui.get("cancel-selected").fire("click");
  assert.equal(JSON.stringify(ui.calls), JSON.stringify([
    ["retry", [{ itemKey: "A", libraryID: 1 }, { itemKey: "B", libraryID: 1 }]],
    ["recheck", [{ itemKey: "C", libraryID: 1 }]], ["cancel", { itemKey: "D", libraryID: 1 }]
  ]));
});

test("changing filter/search clears hidden selection; unchanged refresh preserves rendered rows", async () => {
  const ui = await setup([fixture("A", "failed"), fixture("B", "failed")]);
  await ui.selectAll();
  const original = ui.get("tasks-body").children[0];
  await ui.window.FullTextFlowTasks.refresh();
  assert.equal(ui.get("tasks-body").children[0], original);
  assert.match(ui.get("selection-summary").textContent, /已选 2/);
  ui.get("search").value = "A";
  await ui.get("search").fire("input");
  assert.match(ui.get("selection-summary").textContent, /显示 1 \/ 2 条 · 已选 0/);
  await ui.selectAll();
  await ui.filter("done");
  assert.equal(ui.get("retry").disabled, true);
  assert.equal(ui.get("select-all").disabled, true);
});

test("quota warning does not invent a daily cap and retry cancellation is respected", async () => {
  const ui = await setup([fixture("A", "failed", { reason: "当日传递次数已达上限" })]);
  assert.equal(ui.get("quota-notice").hidden, false);
  assert.match(ui.get("quota-notice").textContent, /无法读取准确日限/);
  await ui.selectAll();
  ui.window.confirm = (message: string) => { assert.match(message, /确认额度已恢复/); return false; };
  await ui.get("retry").fire("click");
  assert.equal(ui.calls.length, 0);
});

test("action errors are visible and buttons recover", async () => {
  const ui = await setup([fixture("A", "failed")]);
  await ui.selectAll();
  ui.api.retrySelected = async () => { throw new Error("offline"); };
  await ui.get("retry").fire("click");
  assert.match(ui.get("feedback").textContent, /offline/);
  assert.equal(ui.get("retry").disabled, false);
});

test("busy retry cannot be double-submitted and stop stays available", async () => {
  const ui = await setup([fixture("A", "failed"), fixture("B", "pending")]);
  await ui.selectAll();
  let release: Function = () => {};
  let requests = 0;
  ui.api.retrySelected = async () => {
    requests++;
    await new Promise(resolve => { release = resolve; });
    return { queued: 1, native: 0, skipped: 0, failed: 0, waitingAuth: 0 };
  };
  const first = ui.get("retry").fire("click");
  assert.equal(ui.get("retry").disabled, true);
  assert.equal(ui.get("cancel-selected").disabled, false);
  await ui.get("retry").fire("click");
  await ui.get("cancel-selected").fire("click");
  assert.equal(requests, 1);
  assert.equal(ui.calls[0][0], "cancel");
  release(); await first;
});

test("manual confirmation requires explicit acknowledgement and only targets review tasks", async () => {
  const ui = await setup([fixture("A", "review"), fixture("B", "done")]);
  await ui.selectAll();
  ui.window.confirm = () => false;
  await ui.get("confirm-reviewed").fire("click");
  assert.equal(ui.calls.length, 0);
  ui.window.confirm = () => true;
  await ui.get("confirm-reviewed").fire("click");
  assert.equal(JSON.stringify(ui.calls), JSON.stringify([["confirmReviewed", [{ itemKey: "A", libraryID: 1 }]]]));
});

test("quota scheduling only enrolls selected eligible failures and can be cancelled", async () => {
  const ui = await setup([fixture("A", "failed", { canScheduleQuota: true }), fixture("B", "failed"), fixture("C", "waiting_quota", { retryAfter: "2026-10-26T00:10:00Z" })]);
  await ui.selectAll();
  assert.equal(ui.get("schedule-quota").textContent, "次日自动获取（1）");
  ui.window.confirm = () => false;
  await ui.get("schedule-quota").fire("click");
  assert.equal(ui.calls.length, 0);
  ui.window.confirm = () => true;
  await ui.get("schedule-quota").fire("click");
  assert.equal(JSON.stringify(ui.calls), JSON.stringify([["scheduleQuota", [{ itemKey: "A", libraryID: 1 }]]]));
  await ui.filter("waiting_quota");
  await ui.selectAll();
  assert.equal(ui.get("retry").disabled, true);
  assert.equal(ui.get("clear-selected").disabled, true);
  assert.equal(ui.get("cancel-selected").disabled, false);
});
