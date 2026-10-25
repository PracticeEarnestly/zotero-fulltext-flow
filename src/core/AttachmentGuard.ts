// Shared by the native and JLSS paths. It serializes FullTextFlow work only;
// other plugins are handled by fresh checks around the asynchronous download.
export class AttachmentGuard {
  private static locks = new Map<string, Promise<unknown>>();

  static async withItemLock<T>(item: any, operation: () => Promise<T>): Promise<T> {
    if (!item) return operation();
    const key = `${item.libraryID}:${item.key || item.id}`;
    const previous = this.locks.get(key) || Promise.resolve();
    const current = previous.catch(() => {}).then(operation);
    this.locks.set(key, current);
    try { return await current; }
    finally { if (this.locks.get(key) === current) this.locks.delete(key); }
  }

  static async sha256(path: string): Promise<string> {
    // Stream the file using the same XPCOM API used by Zotero's md5Async,
    // with SHA-256; do not load entire PDFs into JavaScript memory.
    const hash = Components.classes["@mozilla.org/security/hash;1"]
      .createInstance(Components.interfaces.nsICryptoHash);
    hash.init(hash.SHA256);
    const stream = Components.classes["@mozilla.org/network/file-input-stream;1"]
      .createInstance(Components.interfaces.nsIFileInputStream);
    try {
      stream.init(Zotero.File.pathToFile(path), -1, -1, Components.interfaces.nsIFileInputStream.CLOSE_ON_EOF);
      hash.updateFromStream(stream, -1);
      return Array.from(hash.finish(false) as string, char => char.charCodeAt(0).toString(16).padStart(2, "0")).join("");
    }
    finally { stream.close(); }
  }
}
