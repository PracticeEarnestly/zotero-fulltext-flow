const ORIGIN = "chrome://fulltextflow";
const HTTP_REALM = "fulltextflow-jlss";

export class SecureStore {
  private static async find(id: string): Promise<any | null> {
    try {
      const loginManager = Services.logins as any;
      const logins: any[] = await loginManager.searchLoginsAsync({ origin: ORIGIN, httpRealm: HTTP_REALM });
      return logins.find(login => login.username === id) || null;
    }
    catch (_) {
      return null;
    }
  }

  static async get(id: string): Promise<string> {
    const login = await this.find(id);
    return login ? String(login.password || "") : "";
  }

  static async set(id: string, value: string): Promise<void> {
    const loginManager = Services.logins as any;
    const existing = await this.find(id);
    if (existing) loginManager.removeLogin(existing);
    if (!value) return;
    const loginInfo = Components.classes[
      "@mozilla.org/login-manager/loginInfo;1"
    ].createInstance(Components.interfaces.nsILoginInfo);
    loginInfo.init(ORIGIN, null, HTTP_REALM, id, value, "", "");
    if (loginManager.addLoginAsync) await loginManager.addLoginAsync(loginInfo);
    else loginManager.addLogin(loginInfo);
  }

  static async remove(id: string): Promise<void> {
    const loginManager = Services.logins as any;
    const existing = await this.find(id);
    if (existing) loginManager.removeLogin(existing);
  }
}
