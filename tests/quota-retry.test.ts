import test from "node:test";
import assert from "node:assert/strict";
import { isDailyQuotaError, nextQuotaAttempt } from "../src/core/QuotaRetry.ts";

test("next quota attempt uses tomorrow at 00:10 local time including year rollover", () => {
  for (const now of [new Date(2026, 11, 31, 23, 59), new Date(2026, 9, 25, 0, 1)]) {
    const next = new Date(nextQuotaAttempt(now));
    const expected = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 10);
    assert.equal(next.getTime(), expected.getTime());
    assert.ok(next > now);
  }
});

test("only the explicit daily quota error is automatically deferred", () => {
  assert.equal(isDailyQuotaError("聚联提交失败：当日传递次数已达上限"), true);
  for (const message of ["网络超时", "登录失效", "月限额不足", "下载失败", ""]) assert.equal(isDailyQuotaError(message), false);
});
