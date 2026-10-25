#!/usr/bin/env python3
"""Read-only PDF duplicate audit. Writes a fresh report, never changes Zotero files.

Copies a stable database/journal set into a private temporary directory, recovers
and checks only that copy, then hashes size-matched local PDFs with SHA-256.
"""
import argparse
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import shutil
import sqlite3
import tempfile


def signature(path):
    try:
        s = path.stat()
        return (s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns, s.st_ctime_ns)
    except FileNotFoundError:
        return None


def snapshot_database(data_dir, target):
    paths = [data_dir / ("zotero.sqlite" + suffix) for suffix in ("", "-journal", "-wal")]
    before = [signature(path) for path in paths]
    if before[0] is None:
        raise RuntimeError("Zotero database does not exist")
    for source, state in zip(paths, before):
        if state is not None:
            shutil.copy2(source, target / source.name)
    if before != [signature(path) for path in paths]:
        raise RuntimeError("Zotero database changed while copying. Rerun when Zotero is idle.")
    # SQLite may recover the copied journal; the source is never opened for writes.
    connection = sqlite3.connect(target / "zotero.sqlite")
    checks = [row[0] for row in connection.execute("PRAGMA quick_check")]
    if checks != ["ok"]:
        connection.close()
        raise RuntimeError(f"Snapshot consistency check failed: {checks[:5]}")
    connection.execute("PRAGMA query_only=ON")
    return connection, before


def resolve_attachment(data_dir, base_dir, record):
    value = record["stored_path"] or ""
    if record["linkMode"] in (0, 1) and value.startswith("storage:"):
        root = (data_dir / "storage" / record["key"]).resolve()
        path = (root / value[len("storage:"):]).resolve()
        if not path.is_relative_to(root):
            raise ValueError("Invalid storage-relative path")
        return path
    if record["linkMode"] == 2:
        if value.startswith("attachments:"):
            if not base_dir:
                raise ValueError("Linked attachment base directory not configured")
            return (base_dir / value[len("attachments:"):]).resolve()
        if Path(value).is_absolute():
            return Path(value).resolve()
    raise ValueError("No resolvable local file path")


def hash_pdf(path):
    before = signature(path)
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        if handle.read(5) != b"%PDF-":
            raise ValueError("Missing PDF signature")
        handle.seek(0)
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    if before != signature(path):
        raise ValueError("File changed while hashing")
    return digest.hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-dir", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True, help="New report directory; must not exist")
    parser.add_argument("--base-dir", type=Path, help="Zotero linked-attachment base directory")
    args = parser.parse_args()
    if args.output.exists():
        raise SystemExit("Output already exists; choose a new report directory")
    with tempfile.TemporaryDirectory(prefix="fulltextflow-audit-") as temporary:
        db, database_signature = snapshot_database(args.data_dir, Path(temporary))
        db.row_factory = sqlite3.Row
        records = [dict(row) for row in db.execute("""
          SELECT a.itemID, a.parentItemID, a.linkMode, a.path AS stored_path,
                 i.key, i.libraryID, i.dateAdded,
                 (SELECT v.value FROM itemData d JOIN fields f ON f.fieldID=d.fieldID
                  JOIN itemDataValues v ON v.valueID=d.valueID
                  WHERE d.itemID=a.parentItemID AND f.fieldName='title' LIMIT 1) AS parent_title,
                 (SELECT count(*) FROM itemAnnotations n WHERE n.parentItemID=a.itemID) AS annotations,
                 (SELECT count(*) FROM itemNotes n WHERE n.parentItemID=a.itemID) AS notes
          FROM itemAttachments a JOIN items i ON i.itemID=a.itemID
          WHERE (lower(a.contentType)='application/pdf' OR lower(a.path) LIKE '%.pdf')
            AND NOT EXISTS (SELECT 1 FROM deletedItems d WHERE d.itemID=a.itemID OR d.itemID=a.parentItemID)
        """)]
        db.close()
    print(f"Inventory: {len(records)} non-trashed PDF attachment records", flush=True)
    files = defaultdict(list)
    issues = []
    for record in records:
        try:
            path = resolve_attachment(args.data_dir, args.base_dir, record)
            stat = path.stat()
            if not path.is_file():
                raise ValueError("Not a regular file")
            record.update(path=str(path), size=stat.st_size, physical_file=f"{stat.st_dev}:{stat.st_ino}")
            files[str(path)].append(record)
        except (OSError, ValueError) as error:
            issues.append({"itemID": record["itemID"], "key": record["key"], "reason": str(error)})
    sizes = defaultdict(list)
    for path, refs in files.items():
        sizes[refs[0]["size"]].append(path)
    candidates = [path for paths in sizes.values() if len(paths) > 1 for path in paths]
    print(f"Local files: {len(files)}; size-matched candidates to hash: {len(candidates)}; unresolved: {len(issues)}", flush=True)

    def checked_hash(value):
        try:
            return value, hash_pdf(Path(value)), None
        except (OSError, ValueError) as error:
            return value, None, str(error)

    hashes = defaultdict(list)
    with ThreadPoolExecutor(max_workers=2) as pool:
        for index, (path, digest, error) in enumerate(pool.map(checked_hash, candidates), 1):
            if error:
                issues.append({"path": path, "reason": error})
            else:
                hashes[digest].append(path)
            if index % 200 == 0:
                print(f"Hashed {index}/{len(candidates)}", flush=True)
    groups = []
    for digest, paths in hashes.items():
        if len(paths) < 2:
            continue
        attachments = [record for path in paths for record in files[path]]
        physical = {record["physical_file"] for record in attachments}
        parents = {(record["libraryID"], record["parentItemID"]) for record in attachments}
        size = attachments[0]["size"]
        groups.append({"sha256": digest, "size": size, "distinct_paths": len(paths),
                       "physical_copies": len(physical), "potential_redundant_bytes": max(0, len(physical)-1)*size,
                       "scope": "same_parent" if len(parents) == 1 and attachments[0]["parentItemID"] else "cross_parent_or_standalone",
                       "attachments": attachments})
    groups.sort(key=lambda group: group["potential_redundant_bytes"], reverse=True)
    summary = {
        "generated_at": datetime.now(timezone.utc).isoformat(), "data_dir": str(args.data_dir),
        "database_snapshot_signature": database_signature, "database_quick_check": "ok",
        "pdf_attachment_records": len(records), "local_unique_paths": len(files), "hashed_paths": len(candidates),
        "duplicate_groups": len(groups), "same_parent_groups": sum(group["scope"] == "same_parent" for group in groups),
        "potential_redundant_bytes": sum(group["potential_redundant_bytes"] for group in groups), "issues": len(issues),
        "notes": "Read-only audit. Excludes trashed items. Hash equality does not imply annotations/notes/parent items are interchangeable. Byte totals are logical estimates, not guaranteed disk savings (APFS clones, backups and sync excluded)."
    }
    args.output.mkdir(parents=True, exist_ok=False)
    (args.output / "duplicates.json").write_text(json.dumps({"summary": summary, "groups": groups, "issues": issues}, ensure_ascii=False, indent=2), encoding="utf8")
    lines = ["# Zotero PDF 重复文件审计", "", f"生成时间：{summary['generated_at']}", "",
             f"非回收站 PDF 附件记录 {len(records)} 条；可读取文件路径 {len(files)} 个；内容相同组 {len(groups)} 组。",
             f"同一父条目内重复 {summary['same_parent_groups']} 组；理论冗余大小 {summary['potential_redundant_bytes']/1024/1024:.2f} MiB。",
             f"缺失、不可解析或无法核验记录 {len(issues)} 条，详见 duplicates.json。", "",
             "本报告未删除或修改 Zotero 文件。内容相同不等于批注相同；处理前需检查批注、笔记、父条目和同步。",
             "批注与笔记数量来自 Zotero 数据库，不包含对 PDF 内嵌批注的解析。",
             "容量为逻辑估算，未计入 APFS 克隆共享、快照、备份和云端同步；不能直接视作可释放磁盘空间。", ""]
    for index, group in enumerate(groups, 1):
        lines += [f"## {index}. {'同一条目内' if group['scope']=='same_parent' else '跨条目或独立附件'}重复", "",
                  f"SHA-256：`{group['sha256']}`；单文件 {group['size']/1024/1024:.2f} MiB；独立文件 {group['physical_copies']} 份。", ""]
        for attachment in group["attachments"]:
            title = str(attachment["parent_title"] or "独立附件").replace("\n", " ")
            lines.append(f"- 附件 `{attachment['key']}` / ID {attachment['itemID']}，库 {attachment['libraryID']}，父条目 {attachment['parentItemID']}；批注 {attachment['annotations']}，笔记 {attachment['notes']}；{title}")
            lines.append(f"  路径：[{attachment['key']}](<{attachment['path']}>)")
        lines.append("")
    (args.output / "report.md").write_text("\n".join(lines) + "\n", encoding="utf8")
    print(json.dumps(summary, ensure_ascii=False), flush=True)
    print(f"Report: {args.output / 'report.md'}", flush=True)


if __name__ == "__main__":
    main()
