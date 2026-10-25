import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import vm from "node:vm";
import ts from "typescript";

function setup(options: any = {}) {
  const files = new Map<string, string>();
  const attachments = new Map<number, any>();
  const stats = { downloads: 0, imports: 0, native: 0, removed: [] as string[], erased: [] as number[], hashed: [] as string[], closedStreams: 0 };
  const item: any = { id: 1, key: "ITEM", libraryID: 1, getAttachments: () => [...attachments.keys()], isRegularItem: () => true };
  const entry = { itemKey: "ITEM", libraryID: 1, title: "Paper", queryText: "Paper" };
  let cancelled = false;
  let index = 0;
  function add(path: string, content = "PDF-content", extra: any = {}) {
    const id = ++index;
    files.set(path, content);
    const attachment = { id, parentID: item.id, attachmentContentType: "application/pdf", getFilePathAsync: async () => path,
      eraseTx: async () => { stats.erased.push(id); attachments.delete(id); files.delete(path); }, ...extra };
    attachments.set(id, attachment);
    return attachment;
  }
  const sandbox: any = {
    Zotero: {
      Items: { getAsync: async (ids: number[]) => ids.map(id => attachments.get(id)) },
      File: { pathToFile: (path: string) => ({ path }) }, logError: () => {},
      Attachments: {
        createTemporaryStorageDirectory: async () => {
          const path = `/tmp/own-${++index}`;
          return { path, clone: () => ({ path, append(name: string) { this.path += `/${name}`; } }) };
        },
        downloadFile: async (_url: string, path: string) => {
          stats.downloads++; files.set(path, "PDF-content"); await options.download?.({ add, cancel: () => { cancelled = true; }, files, path });
        },
        createURLAttachmentFromTemporaryStorageDirectory: async (args: any) => {
          stats.imports++;
          const path = `${args.directory}/${args.filename}`;
          const content = files.get(path)!;
          files.delete(path);
          return add(`/storage/import-${index}.pdf`, content);
        },
        addAvailableFile: async () => { stats.native++; await options.native?.(); return add("/storage/native.pdf"); }
      }
    },
    IOUtils: {
      exists: async (path: string) => files.has(path),
      remove: async (path: string) => { stats.removed.push(path); for (const file of files.keys()) if (file.startsWith(path + "/")) files.delete(file); }
    },
    QueueStore: { isCancelled: () => cancelled },
    PdfVerifier: {
      verifyStructure: async () => { if (options.invalid) throw new Error("not PDF"); },
      verify: async () => { if (options.verifyError) throw new Error("index error"); return { status: "verified", reason: "OK" }; }
    },
    Components: {
      interfaces: { nsICryptoHash: {}, nsIFileInputStream: { CLOSE_ON_EOF: 1 } },
      classes: {
        "@mozilla.org/security/hash;1": { createInstance: () => {
          const hash = createHash("sha256");
          return { SHA256: 2, init: () => {}, updateFromStream: (stream: any) => { stats.hashed.push(stream.path); hash.update(files.get(stream.path)!); }, finish: () => hash.digest("latin1") };
        } },
        "@mozilla.org/network/file-input-stream;1": { createInstance: () => ({ path: "", init(file: any) { this.path = file.path; }, close() { stats.closedStreams++; } }) }
      }
    }
  };
  const source = ["AttachmentDetector", "AttachmentGuard", "NativeFullText", "PdfImporter"]
    .map(name => readFileSync(new URL(`../src/core/${name}.ts`, import.meta.url), "utf8").replace(/^import .*$/gm, "").replace(/^export /gm, ""))
    .join("\n");
  vm.runInNewContext(ts.transpileModule(source + "\nglobalThis.importer = PdfImporter; globalThis.native = NativeFullText; globalThis.guard = AttachmentGuard;", { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText, sandbox);
  return { ...sandbox, item, entry, files, attachments, stats, add,
    run: () => sandbox.importer.importFromURL(item, entry, "https://example.invalid/file.pdf") };
}

test("existing PDF is reused without downloading, importing, deleting or touching annotations", async () => {
  const env = setup();
  const original = env.add("/existing.pdf", "PDF-content", { annotations: ["note"] });
  const result = await env.run();
  assert.equal(result.attachment, original);
  assert.equal(result.reused, true);
  assert.equal(env.stats.downloads, 0);
  assert.equal(env.stats.imports, 0);
  assert.deepEqual(env.stats.erased, []);
  assert.deepEqual(original.annotations, ["note"]);
});

test("PDF arriving during download with identical SHA-256 discards only the private temp file", async () => {
  const env = setup({ download: ({ add }: any) => add("/external.pdf") });
  const result = await env.run();
  assert.equal(result.reused, true);
  assert.match(result.verification.reason, /SHA-256/);
  assert.equal(env.stats.imports, 0);
  assert.equal(env.stats.closedStreams, 2);
  assert.deepEqual([...env.files.keys()], ["/external.pdf"]);
  assert.deepEqual(env.stats.erased, []);
  assert.ok(env.stats.removed.every(path => path.startsWith("/tmp/own-")));
});

test("different PDF arriving during download is preserved and flagged for review", async () => {
  const env = setup({ download: ({ add }: any) => add("/external.pdf", "another PDF") });
  const result = await env.run();
  assert.equal(result.reused, true);
  assert.equal(result.verification.status, "review");
  assert.equal(env.stats.imports, 0);
  assert.deepEqual([...env.files.keys()], ["/external.pdf"]);
});

test("concurrent JLSS imports for the same item perform one download/import", async () => {
  const env = setup();
  const results = await Promise.all([env.run(), env.run(), env.run()]);
  assert.equal(env.stats.downloads, 1);
  assert.equal(env.stats.imports, 1);
  assert.equal(results[0].attachment, results[1].attachment);
  assert.equal(results[0].attachment, results[2].attachment);
});

test("native and JLSS paths share the item lock", async () => {
  const env = setup();
  const [native, jlss] = await Promise.all([env.native.tryFind(env.item), env.run()]);
  assert.equal(native.found, true);
  assert.equal(jlss.reused, true);
  assert.equal(env.stats.native, 1);
  assert.equal(env.stats.downloads, 0);
});

test("failure cleans temporary data and releases the lock for a later attempt", async () => {
  let attempts = 0;
  const env = setup({ download: () => { if (++attempts === 1) throw new Error("network failure"); } });
  await assert.rejects(env.run(), /network failure/);
  assert.equal(env.files.size, 0);
  const result = await env.run();
  assert.equal(result.verification.status, "verified");
  assert.equal(env.stats.imports, 1);
});

test("cancelled download and invalid PDF never create stored attachments", async () => {
  for (const options of [{ download: ({ cancel }: any) => cancel() }, { invalid: true }]) {
    const env = setup(options);
    await assert.rejects(env.run());
    assert.equal(env.stats.imports, 0);
    assert.equal(env.files.size, 0);
  }
});

test("verification error after commit preserves the new attachment for review", async () => {
  const env = setup({ verifyError: true });
  const result = await env.run();
  assert.equal(result.verification.status, "review");
  assert.equal(env.attachments.size, 1);
  assert.deepEqual(env.stats.erased, []);
});

test("missing local PDF and deleted attachments do not prevent legitimate retrieval", async () => {
  const env = setup();
  env.add("/missing.pdf"); env.files.delete("/missing.pdf");
  env.add("/trashed.pdf", "old", { deleted: true });
  await env.run();
  assert.equal(env.stats.downloads, 1);
  assert.equal(env.stats.imports, 1);
  assert.equal(env.files.get("/trashed.pdf"), "old");
});

test("hashing uses SHA-256 hex and the lock is scoped by library", async () => {
  const env = setup();
  env.files.set("/known.pdf", "abc");
  assert.equal(await env.guard.sha256("/known.pdf"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  let release: any;
  const first = env.guard.withItemLock({ libraryID: 1, key: "SAME" }, () => new Promise(resolve => { release = resolve; }));
  await Promise.resolve();
  const second = await env.guard.withItemLock({ libraryID: 2, key: "SAME" }, async () => "other library");
  assert.equal(second, "other library");
  release(); await first;
  assert.equal((await env.native.tryFind(null)).found, false);
});
