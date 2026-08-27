import { JLSS_BASE_URL } from "../config";
import type { ItemMetadata } from "./Metadata";
import { AuthManager } from "./AuthManager";

export type JLSSRecord = {
  taskTitle: string;
  taskCode: string;
  createTime: string;
  taskStatus: string;
  uuid: string;
  resourceUuid: string;
};

export class JLSSAuthRequiredError extends Error {
  constructor(message = "需要登录聚联。") {
    super(message);
    this.name = "JLSSAuthRequiredError";
  }
}

export class JLSSClient {
  private static async post(path: string, body: unknown, allowRecovery = true): Promise<any> {
    let token = await AuthManager.token();
    if (!token && allowRecovery) {
      token = await AuthManager.recoverTokenFromWebStorage();
    }
    if (!token) {
      throw new JLSSAuthRequiredError("尚未捕获聚联 token。请在 FullTextFlow 聚联登录窗口完成登录，然后点击“检测登录状态”。");
    }

    const response = await Zotero.HTTP.request("POST", `${JLSS_BASE_URL}${path}`, {
      body: JSON.stringify(body),
      headers: {
        Accept: "application/json, text/plain, */*",
        "Content-Type": "application/json",
        token
      },
      responseType: "text",
      successCodes: false,
      timeout: 60000
    });

    let authFailure = response.status === 401 || response.status === 403;
    let data: any = null;
    if (!authFailure) {
      try { data = JSON.parse(response.responseText || "{}"); }
      catch (_) {
        if (/^\s*</.test(response.responseText || "")) authFailure = true;
        else throw new Error("聚联返回了非 JSON 数据，接口可能已变化。");
      }
      if (data?.code === 501) authFailure = true;
    }

    if (authFailure) {
      await AuthManager.clearToken();
      if (allowRecovery) {
        const recovered = await AuthManager.recoverTokenFromWebStorage();
        // If the web page has a newer token than the secure-store copy, retry
        // once transparently. This is the key fix for 0.2.1's
        // "web page logged in but API still says login required" failure.
        if (recovered && recovered !== token) {
          return this.post(path, body, false);
        }
      }
      throw new JLSSAuthRequiredError("聚联网页登录状态存在，但 API token 未能同步或已失效。请重新打开“FullTextFlow 聚联登录”并点击“检测登录状态”。");
    }

    if (response.status < 200 || response.status >= 300 || data?.code !== 200) {
      throw new Error(data?.msg || data?.mess || data?.message || `聚联请求失败 HTTP ${response.status}`);
    }
    return data;
  }

  static async testConnection(): Promise<boolean> {
    await this.listAllTasks(1);
    return true;
  }

  static submit(metadata: ItemMetadata) {
    if (!metadata.queryText) throw new Error("条目缺少 DOI、PMID、标题和 URL。");
    return this.post("/search/trans", { content: metadata.queryText });
  }

  static async listAllTasks(maxPages = 20): Promise<JLSSRecord[]> {
    const all: JLSSRecord[] = [];
    const pageSize = 50;
    for (let page = 1; page <= maxPages; page++) {
      const response = await this.post("/task/myHelpList", {
        currentPage: page,
        pageSize,
        data: { taskStatus: "", startTime: "", endTime: "" }
      });
      const payload = response?.data || {};
      const rows = payload.dataList || payload.list || payload.records || [];
      if (!Array.isArray(rows)) throw new Error("聚联任务列表格式异常。");
      for (const row of rows) {
        all.push({
          taskTitle: String(row.taskTitle || ""),
          taskCode: String(row.taskCode || ""),
          createTime: String(row.createTime || ""),
          taskStatus: String(row.taskStatus ?? ""),
          uuid: String(row.uuid || ""),
          resourceUuid: String(row.resourceUuid || "")
        });
      }
      if (rows.length < pageSize) break;
    }
    return all;
  }

  static async getDownloadURL(record: JLSSRecord): Promise<string> {
    if (!record.resourceUuid || !record.uuid) throw new Error("聚联任务缺少下载参数。");
    const response = await this.post("/task/clickDownload", {
      resourceUuid: record.resourceUuid,
      uuid: record.uuid
    });
    const payload = response?.data || {};
    if (payload.code !== 0 || !payload.data) throw new Error(payload.msg || "聚联未返回 PDF 下载链接。");
    return String(payload.data);
  }
}
