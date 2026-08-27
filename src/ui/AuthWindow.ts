import { PLUGIN_NAME } from "../config";
import { AuthManager } from "../core/AuthManager";
import { JLSSClient } from "../core/JLSSClient";
import type { FlowEngine } from "../core/FlowEngine";

export class AuthWindow {
  static async open(win: any, engine: FlowEngine) {
    const existing = Services.wm.getMostRecentWindow("fulltextflow:auth") as any;
    if (existing) { existing.focus?.(); return; }
    const credentials = await AuthManager.credentials();
    const bridge = {
      pluginName: PLUGIN_NAME,
      credentials,
      saveToken: async (token: string) => AuthManager.setToken(token),
      recoverToken: async () => AuthManager.recoverTokenFromWebStorage(),
      currentToken: async () => AuthManager.token(),
      testConnection: async () => JLSSClient.testConnection(),
      resume: async () => engine.resumeAuthWaiting(),
      openExternal: () => Zotero.launchURL("https://jlyl.jlss.vip/jss/")
    };
    win.openDialog(
      "chrome://fulltextflow/content/auth-window.xhtml",
      "fulltextflow-auth",
      "chrome,centerscreen,resizable,width=1040,height=760",
      { wrappedJSObject: bridge }
    );
  }
}
