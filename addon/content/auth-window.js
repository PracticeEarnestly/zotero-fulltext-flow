/* global window, document, Components, Services */
(() => {
  const api = window.arguments?.[0]?.wrappedJSObject;
  const LOGIN_URL = "https://jlyl.jlss.vip/jss/";
  let lastAutoFillAt = 0;
  let success = false;
  let probing = false;

  const status = text => { document.getElementById("status").textContent = text; };
  const browser = () => document.getElementById("jlss-browser");

  function contentWindow() {
    const b = browser();
    return b?.contentWindow || b?.contentDocument?.defaultView || null;
  }

  function pageTarget() {
    const w = contentWindow();
    if (!w) return null;
    try { return w.wrappedJSObject || w; }
    catch (_) { return w; }
  }

  function normalizeToken(value) {
    let token = String(value || "").trim();
    if (!token) return "";
    if ((token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'"))) {
      token = token.slice(1, -1).trim();
    }
    return token.replace(/^Bearer\s+/i, "").trim();
  }

  function setInputValue(target, input, value) {
    if (!input || !value) return;
    try {
      const proto = target.HTMLInputElement?.prototype;
      const setter = proto && Object.getOwnPropertyDescriptor(proto, "value")?.set;
      if (setter) setter.call(input, value); else input.value = value;
      input.dispatchEvent(new target.Event("input", { bubbles: true }));
      input.dispatchEvent(new target.Event("change", { bubbles: true }));
    }
    catch (_) { input.value = value; }
  }

  function visible(el) {
    try {
      const r = el.getBoundingClientRect();
      const style = el.ownerDocument.defaultView.getComputedStyle(el);
      return r.width > 0 && r.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    }
    catch (_) { return true; }
  }

  function findLoginControls(doc) {
    const inputs = Array.from(doc.querySelectorAll("input")).filter(visible);
    const password = inputs.find(i => String(i.type || "").toLowerCase() === "password");
    if (!password) return null;
    const preferred = inputs.filter(i => i !== password && !["hidden", "password", "checkbox", "radio", "submit", "button"].includes(String(i.type || "").toLowerCase()));
    const username = preferred.find(i => /user|account|phone|mobile|email|login|name|账号|手机|邮箱/i.test(`${i.name || ""} ${i.id || ""} ${i.placeholder || ""}`)) || preferred[preferred.length - 1];
    const form = password.form || password.closest("form");
    const buttons = Array.from((form || doc).querySelectorAll("button,input[type=submit],input[type=button]")).filter(visible);
    const submit = buttons.find(b => /登录|登陆|login|sign\s*in/i.test(String(b.textContent || b.value || b.getAttribute?.("aria-label") || ""))) || buttons.find(b => String(b.type || "").toLowerCase() === "submit") || buttons[0];
    return { username, password, submit, form };
  }

  async function tryAutofill() {
    const creds = api?.credentials || {};
    if (!creds.username || !creds.password) {
      status("未保存聚联账号。请关闭窗口后在“工具 → FullTextFlow 聚联账号”中设置，或在本页手动登录。");
      return false;
    }
    const target = pageTarget();
    if (!target) return false;
    try {
      const controls = findLoginControls(target.document);
      if (!controls) return false;
      setInputValue(target, controls.username, creds.username);
      setInputValue(target, controls.password, creds.password);
      lastAutoFillAt = Date.now();
      status("已自动填入账号密码，正在尝试登录…如出现验证码，请手动完成。");
      setTimeout(() => {
        try {
          if (controls.submit?.click) controls.submit.click();
          else if (controls.form?.requestSubmit) controls.form.requestSubmit();
          else if (controls.form?.submit) controls.form.submit();
        } catch (_) {}
      }, 350);
      return true;
    }
    catch (e) {
      status(`自动填充受网页隔离限制：${e?.message || e}。请在本页手动登录；插件会使用跨进程方式继续捕获 token。`);
      return false;
    }
  }

  function readTokenDirectly() {
    const target = pageTarget();
    if (!target) return "";
    try {
      return normalizeToken(target.localStorage?.getItem("token") || target.sessionStorage?.getItem("token") || "");
    }
    catch (_) { return ""; }
  }

  /**
   * Read token inside the content process with a frame script. This is the
   * primary 0.2.2 fix for Zotero/Gecko process isolation: chrome code may not
   * be allowed to dereference contentWindow.localStorage even when the page is
   * visibly logged in.
   */
  function readTokenViaFrameScript() {
    return new Promise(resolve => {
      const mm = browser()?.messageManager;
      if (!mm?.addMessageListener || !mm?.loadFrameScript) {
        resolve("");
        return;
      }
      const topic = `FullTextFlow:JLSS-token:${Date.now()}:${Math.random()}`;
      let settled = false;
      const finish = value => {
        if (settled) return;
        settled = true;
        try { mm.removeMessageListener(topic, listener); } catch (_) {}
        resolve(normalizeToken(value));
      };
      const listener = message => finish(message?.data?.token || "");
      try {
        mm.addMessageListener(topic, listener);
        const source = `(() => { let token = \"\"; try { token = String(content.localStorage.getItem(\"token\") || content.sessionStorage.getItem(\"token\") || \"\"); } catch (_) {} sendAsyncMessage(${JSON.stringify(topic)}, { token, href: String(content.location?.href || \"\") }); })();`;
        mm.loadFrameScript(`data:application/javascript;charset=utf-8,${encodeURIComponent(source)}`, false);
        setTimeout(() => finish(""), 1800);
      }
      catch (_) { finish(""); }
    });
  }

  async function captureToken() {
    // 1) Fast path for non-isolated Gecko/browser builds.
    let token = readTokenDirectly();
    if (token) return { token, method: "page" };

    // 2) Cross-process content script path.
    token = await readTokenViaFrameScript();
    if (token) return { token, method: "content-process" };

    // 3) Privileged localStorage manager path implemented in AuthManager.
    try { token = normalizeToken(await api?.recoverToken?.()); }
    catch (_) { token = ""; }
    if (token) return { token, method: "storage-manager" };

    return { token: "", method: "none" };
  }

  async function probeToken() {
    if (probing || success) return false;
    probing = true;
    try {
      const captured = await captureToken();
      if (!captured.token) {
        const now = Date.now();
        if (now - lastAutoFillAt > 3500) await tryAutofill();
        status("网页登录页已打开，但 FullTextFlow 尚未捕获 API token。若你已经看到聚联首页，请点击“检测登录状态”；0.2.2 会通过内容进程和 Web Storage 两条路径读取 token。");
        return false;
      }

      status(`已通过 ${captured.method} 捕获登录凭证，正在验证聚联 API…`);
      await api.saveToken(captured.token);
      await api.testConnection();
      success = true;
      status("聚联 API 登录验证成功。正在恢复之前等待登录的全文任务…");
      try { await api.resume(); } catch (_) {}
      setTimeout(() => window.close(), 1200);
      return true;
    }
    catch (e) {
      const secureToken = normalizeToken(await api?.currentToken?.().catch?.(() => "") || "");
      status(`网页登录已完成，但 API 验证仍失败：${e?.message || e}${secureToken ? "（已捕获 token，但服务端拒绝）" : "（尚未捕获 token）"}`);
      return false;
    }
    finally { probing = false; }
  }

  function load() {
    success = false;
    status("正在加载聚联登录页…");
    browser().setAttribute("src", LOGIN_URL);
  }

  window.addEventListener("load", () => {
    browser().addEventListener("load", () => {
      setTimeout(() => probeToken(), 700);
      setTimeout(() => tryAutofill(), 1100);
      setTimeout(() => probeToken(), 2600);
    });
    document.getElementById("autofill").addEventListener("command", () => tryAutofill());
    document.getElementById("detect").addEventListener("command", () => probeToken());
    document.getElementById("reload").addEventListener("command", load);
    document.getElementById("external").addEventListener("command", () => api.openExternal());
    document.getElementById("close").addEventListener("command", () => window.close());
    load();
    setInterval(() => probeToken(), 1800);
  }, { once: true });
})();
