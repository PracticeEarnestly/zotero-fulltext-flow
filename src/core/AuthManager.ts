import { PREF_PREFIX } from "../config";
import { SecureStore } from "./SecureStore";

const TOKEN_ID = "jlss-token";
const USERNAME_ID = "jlss-username";
const PASSWORD_ID = "jlss-password";
const JLSS_WEB_ORIGINS = [
  "https://jlyl.jlss.vip",
  "https://jlss.vip",
  "https://www.jlss.vip"
];
const TOKEN_KEYS = ["token", "access_token", "accessToken", "authToken", "jwt", "authorization"];

export type JLSSCredentials = { username: string; password: string };

export class AuthManager {
  static async initialize() {
    // Migrate the 0.2.0 plaintext token into the login manager and then erase it.
    const legacy = String(Zotero.Prefs.get(`${PREF_PREFIX}.token`) || "").trim();
    if (legacy && !(await SecureStore.get(TOKEN_ID))) {
      await SecureStore.set(TOKEN_ID, legacy);
    }
    if (legacy) Zotero.Prefs.set(`${PREF_PREFIX}.token`, "");
  }

  static async token(): Promise<string> {
    return String(await SecureStore.get(TOKEN_ID)).trim();
  }

  static async setToken(token: string): Promise<void> {
    await SecureStore.set(TOKEN_ID, this.normalizeToken(token));
  }

  static async clearToken(): Promise<void> {
    await SecureStore.remove(TOKEN_ID);
  }

  static async credentials(): Promise<JLSSCredentials> {
    return {
      username: await SecureStore.get(USERNAME_ID),
      password: await SecureStore.get(PASSWORD_ID)
    };
  }

  static async setCredentials(username: string, password: string): Promise<void> {
    await SecureStore.set(USERNAME_ID, String(username || "").trim());
    await SecureStore.set(PASSWORD_ID, String(password || ""));
  }

  static async clearCredentials(): Promise<void> {
    await SecureStore.remove(USERNAME_ID);
    await SecureStore.remove(PASSWORD_ID);
  }

  static async clearAll(): Promise<void> {
    await this.clearToken();
    await this.clearCredentials();
  }

  /**
   * Recover the JLSS web token from Zotero's own web-storage profile.
   *
   * 0.2.1 tried to read <browser>.contentWindow.localStorage directly. That can
   * be blocked by Gecko process/security isolation even when the embedded page
   * itself is already logged in. This method reads the same origin's
   * localStorage through the privileged DOM storage manager instead.
   *
   * No secret values are logged. A recovered candidate is always validated by
   * JLSSClient before it is considered usable.
   */
  static async recoverTokenFromWebStorage(): Promise<string> {
    for (const origin of JLSS_WEB_ORIGINS) {
      try {
        const storage = this.storageForOrigin(origin);
        if (!storage) continue;
        const token = this.extractTokenFromStorage(storage);
        if (token) {
          await this.setToken(token);
          return token;
        }
      }
      catch (e) {
        Zotero.debug(`FullTextFlow: unable to inspect JLSS web storage for ${origin}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    return "";
  }

  static async hasToken() { return Boolean(await this.token()); }
  static async hasCredentials() {
    const c = await this.credentials();
    return Boolean(c.username && c.password);
  }

  private static storageForOrigin(origin: string): any | null {
    const uri = Services.io.newURI(`${origin}/`);
    const ssm = Services.scriptSecurityManager || Components.classes[
      "@mozilla.org/scriptsecuritymanager;1"
    ].getService(Components.interfaces.nsIScriptSecurityManager);
    const principal = ssm.createContentPrincipal
      ? ssm.createContentPrincipal(uri, {})
      : ssm.getNoAppCodebasePrincipal(uri);
    const manager = Components.classes[
      "@mozilla.org/dom/localStorage-manager;1"
    ]?.getService(Components.interfaces.nsIDOMStorageManager);
    if (!manager) return null;

    // Firefox/Zotero versions expose slightly different nsIDOMStorageManager
    // signatures. Try modern Gecko first and keep legacy fallbacks.
    const attempts = [
      () => manager.createStorage?.(null, principal, principal, `${origin}/`, false),
      () => manager.getLocalStorageForPrincipal?.(principal, `${origin}/`, false),
      () => manager.getStorage?.(principal, false),
      () => manager.createStorage?.(principal, `${origin}/`, false)
    ];
    for (const attempt of attempts) {
      try {
        const storage = attempt();
        if (storage) return storage;
      }
      catch (_) {}
    }
    return null;
  }

  private static extractTokenFromStorage(storage: any): string {
    for (const key of TOKEN_KEYS) {
      try {
        const token = this.normalizeToken(storage.getItem?.(key));
        if (token) return token;
      }
      catch (_) {}
    }

    // Some SPA builds persist auth state in a JSON object rather than a
    // top-level `token` key. Search only auth-looking JSON fields.
    let length = 0;
    try { length = Math.min(Number(storage.length || 0), 100); }
    catch (_) {}
    for (let i = 0; i < length; i++) {
      try {
        const key = String(storage.key?.(i) || "");
        const raw = String(storage.getItem?.(key) || "");
        if (!raw) continue;
        if (/token|auth|jwt/i.test(key)) {
          const direct = this.normalizeToken(raw);
          if (direct && !/^[\[{]/.test(direct)) return direct;
        }
        if (/^[\[{]/.test(raw.trim())) {
          const parsed = JSON.parse(raw);
          const nested = this.findTokenInJSON(parsed, 0);
          if (nested) return nested;
        }
      }
      catch (_) {}
    }
    return "";
  }

  private static findTokenInJSON(value: any, depth: number): string {
    if (!value || depth > 5) return "";
    if (Array.isArray(value)) {
      for (const item of value.slice(0, 30)) {
        const found = this.findTokenInJSON(item, depth + 1);
        if (found) return found;
      }
      return "";
    }
    if (typeof value !== "object") return "";
    for (const [key, child] of Object.entries(value).slice(0, 100)) {
      if (/^(token|access[_-]?token|accessToken|authToken|jwt|authorization)$/i.test(key)) {
        const token = this.normalizeToken(child);
        if (token) return token;
      }
      const found = this.findTokenInJSON(child, depth + 1);
      if (found) return found;
    }
    return "";
  }

  private static normalizeToken(value: any): string {
    let token = String(value || "").trim();
    if (!token) return "";
    // localStorage devtools often shows string values with surrounding quotes.
    if ((token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'"))) {
      token = token.slice(1, -1).trim();
    }
    token = token.replace(/^Bearer\s+/i, "").trim();
    return token;
  }
}
