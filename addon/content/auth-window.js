/* global window, document */
(() => {
  const api = window.arguments?.[0]?.wrappedJSObject;
  const LOGIN_URL = "https://jlyl.jlss.vip/jss/";
  let lastAutoFillAt = 0;
  let probing = false;
  let fullLoginConfirmed = false;
  let closeScheduled = false;

  const statusNode = () => document.getElementById("status");
  const browser = () => document.getElementById("jlss-browser");

  function setStatus(text, level = "neutral") {
    const node = statusNode();
    node.textContent = text;
    const colors = {
      success: "#18794e",
      warning: "#9a6700",
      error: "#b42318",
      neutral: "inherit"
    };
    node.style.color = colors[level] || colors.neutral;
  }

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
      setStatus("未保存聚联账号。请关闭窗口后在“工具 → FullTextFlow 聚联账号”中设置，或在本页手动登录。", "warning");
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
      setStatus("检测到登录页，已自动填入账号密码，正在尝试重新登录…如出现验证码，请手动完成。", "warning");
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
      setStatus(`自动填充受网页隔离限制：${e?.message || e}。请在本页手动登录。`, "warning");
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
        const source = `(() => { let token = \"\"; try { token = String(content.localStorage.getItem(\"token\") || content.sessionStorage.getItem(\"token\") || \"\"); } catch (_) {} sendAsyncMessage(${JSON.stringify(topic)}, { token }); })();`;
        mm.loadFrameScript(`data:application/javascript;charset=utf-8,${encodeURIComponent(source)}`, false);
        setTimeout(() => finish(""), 1800);
      }
      catch (_) { finish(""); }
    });
  }

  async function captureToken() {
    let token = readTokenDirectly();
    if (token) return { token, method: "page" };
    token = await readTokenViaFrameScript();
    if (token) return { token, method: "content-process" };
    try { token = normalizeToken(await api?.recoverToken?.()); }
    catch (_) { token = ""; }
    if (token) return { token, method: "storage-manager" };
    return { token: "", method: "none" };
  }

  function analyzeWebSession(doc, href) {
    let hasPassword = false;
    let bodyText = "";
    try {
      hasPassword = Array.from(doc.querySelectorAll("input[type=password]")).some(visible);
      bodyText = String(doc.body?.innerText || doc.documentElement?.innerText || "").replace(/\s+/g, " ").slice(0, 120000);
    }
    catch (_) {}

    const url = String(href || "").toLowerCase();
    const loginRoute = /(?:\/|#|[?&])(login|signin|sign-in|auth)(?:\/|$|[?&=])/i.test(url);
    const negativeText = /登录\s*[|/·]?\s*注册|注册\s*[|/·]?\s*登录|请(?:先)?登录|登录后(?:才能|方可|可)|立即登录|账号登录|密码登录|重新登录/i.test(bodyText);
    const strongPositive = /退出登录|退出系统|安全退出|注销登录|log\s*out|sign\s*out/i.test(bodyText);

    if (hasPassword || loginRoute || negativeText) {
      return { state: "expired", method: hasPassword ? "password-field" : loginRoute ? "login-route" : "login-marker" };
    }
    if (strongPositive) return { state: "authenticated", method: "logout-marker" };
    return { state: "unknown", method: "no-strong-marker" };
  }

  function probeWebSessionDirect() {
    const target = pageTarget();
    if (!target?.document) return null;
    try {
      return analyzeWebSession(target.document, target.location?.href || "");
    }
    catch (_) { return null; }
  }

  function probeWebSessionViaFrameScript() {
    return new Promise(resolve => {
      const mm = browser()?.messageManager;
      if (!mm?.addMessageListener || !mm?.loadFrameScript) {
        resolve(null);
        return;
      }
      const topic = `FullTextFlow:JLSS-session:${Date.now()}:${Math.random()}`;
      let settled = false;
      const finish = value => {
        if (settled) return;
        settled = true;
        try { mm.removeMessageListener(topic, listener); } catch (_) {}
        resolve(value || null);
      };
      const listener = message => finish(message?.data || null);
      try {
        mm.addMessageListener(topic, listener);
        const source = `(() => {
          let href = \"\", text = \"\", hasPassword = false;
          try {
            href = String(content.location?.href || \"\");
            const doc = content.document;
            const visible = el => { try { const r = el.getBoundingClientRect(); const s = content.getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== \"hidden\" && s.display !== \"none\"; } catch (_) { return true; } };
            hasPassword = Array.from(doc.querySelectorAll(\"input[type=password]\")).some(visible);
            text = String(doc.body?.innerText || doc.documentElement?.innerText || \"\").replace(/\\s+/g, \" \" ).slice(0, 120000);
          } catch (_) {}
          const loginRoute = /(?:\\/|#|[?&])(login|signin|sign-in|auth)(?:\\/|$|[?&=])/i.test(href.toLowerCase());
          const negativeText = /登录\\s*[|/·]?\\s*注册|注册\\s*[|/·]?\\s*登录|请(?:先)?登录|登录后(?:才能|方可|可)|立即登录|账号登录|密码登录|重新登录/i.test(text);
          const strongPositive = /退出登录|退出系统|安全退出|注销登录|log\\s*out|sign\\s*out/i.test(text);
          const state = (hasPassword || loginRoute || negativeText) ? \"expired\" : strongPositive ? \"authenticated\" : \"unknown\";
          const method = hasPassword ? \"password-field\" : loginRoute ? \"login-route\" : negativeText ? \"login-marker\" : strongPositive ? \"logout-marker\" : \"no-strong-marker\";
          sendAsyncMessage(${JSON.stringify(topic)}, { state, method });
        })();`;
        mm.loadFrameScript(`data:application/javascript;charset=utf-8,${encodeURIComponent(source)}`, false);
        setTimeout(() => finish(null), 1800);
      }
      catch (_) { finish(null); }
    });
  }

  async function probeWebSession() {
    const direct = probeWebSessionDirect();
    if (direct?.state === "expired" || direct?.state === "authenticated") return { ...direct, path: "page" };
    const framed = await probeWebSessionViaFrameScript();
    if (framed?.state === "expired" || framed?.state === "authenticated") return { ...framed, path: "content-process" };
    return direct || framed || { state: "unknown", method: "unavailable", path: "none" };
  }

  async function probeLoginState() {
    if (probing) return false;
    probing = true;
    try {
      const captured = await captureToken();
      const web = await probeWebSession();

      if (!captured.token) {
        fullLoginConfirmed = false;
        if (web.state === "expired") {
          setStatus("聚联网页会话已失效，需要重新登录。正在尝试自动填充；如出现验证码，请手动完成。", "error");
          if (Date.now() - lastAutoFillAt > 3500) await tryAutofill();
        }
        else {
          setStatus("网页登录页已打开，但 FullTextFlow 尚未捕获 API token。请完成聚联登录后再检测。", "warning");
        }
        return false;
      }

      await api.saveToken(captured.token);
      try {
        await api.testConnection();
      }
      catch (e) {
        fullLoginConfirmed = false;
        setStatus(`聚联 API token 验证失败：${e?.message || e}。请重新登录。`, "error");
        if (Date.now() - lastAutoFillAt > 3500) await tryAutofill();
        return false;
      }

      if (web.state === "expired") {
        fullLoginConfirmed = false;
        setStatus("网页会话已失效，需要重新登录；API token 暂时仍可用。FullTextFlow 不再把此状态显示为“登录成功”。", "error");
        if (Date.now() - lastAutoFillAt > 3500) await tryAutofill();
        return false;
      }

      if (web.state !== "authenticated") {
        fullLoginConfirmed = false;
        setStatus(`聚联 API 可用，但网页会话未确认（${web.method}）。请在下方页面确认账号状态或重新登录；只有双重验证通过才会显示登录成功。`, "warning");
        return false;
      }

      fullLoginConfirmed = true;
      setStatus(`聚联登录成功：API 与网页会话均已验证（token: ${captured.method}; session: ${web.path}/${web.method}）。正在恢复等待任务…`, "success");
      try { await api.resume(); } catch (_) {}
      if (!closeScheduled) {
        closeScheduled = true;
        setTimeout(() => { if (fullLoginConfirmed) window.close(); }, 1500);
      }
      return true;
    }
    catch (e) {
      fullLoginConfirmed = false;
      setStatus(`登录状态检测失败：${e?.message || e}`, "error");
      return false;
    }
    finally { probing = false; }
  }

  function load() {
    fullLoginConfirmed = false;
    closeScheduled = false;
    setStatus("正在加载聚联登录页并验证网页会话 + API token…");
    browser().setAttribute("src", LOGIN_URL);
  }

  window.addEventListener("load", () => {
    browser().addEventListener("load", () => {
      setTimeout(() => probeLoginState(), 700);
      setTimeout(() => {
        const direct = probeWebSessionDirect();
        if (direct?.state === "expired") tryAutofill();
      }, 1100);
      setTimeout(() => probeLoginState(), 2800);
    });
    document.getElementById("autofill").addEventListener("command", () => tryAutofill());
    document.getElementById("detect").addEventListener("command", () => probeLoginState());
    document.getElementById("reload").addEventListener("command", load);
    document.getElementById("external").addEventListener("command", () => api.openExternal());
    document.getElementById("close").addEventListener("command", () => window.close());
    load();
    window.setInterval(() => probeLoginState(), 3000);
  }, { once: true });
})();
