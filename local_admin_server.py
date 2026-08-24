#!/usr/bin/env python3
"""本地管理员标注修改服务。

只监听本机，读取 annotations 下已有 JSON，并在管理员确认后原地覆盖。
不调用 GitHub API，不创建新的标注文件。
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import tempfile
from collections import Counter
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse


ROOT = Path(__file__).resolve().parent
ANNOTATIONS_ROOT = (ROOT / "annotations").resolve()
CONFIG_PATH = ROOT / "config.js"
ANNOTATION_NAME_RE = re.compile(r"^line_(\d+)__(.+)\.json$")
DATASET_RE = re.compile(
    r"\{\s*id:\s*[\"']([^\"']+)[\"']\s*,\s*name:\s*[\"']([^\"']+)[\"']\s*,\s*file:\s*[\"']([^\"']+)[\"']",
    re.S,
)


def json_bytes(value: Any) -> bytes:
    return (json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode("utf-8")


def file_sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def load_dataset_config() -> list[dict[str, str]]:
    configured: list[dict[str, str]] = []
    if CONFIG_PATH.exists():
        text = CONFIG_PATH.read_text(encoding="utf-8")
        for dataset_id, name, filename in DATASET_RE.findall(text):
            configured.append({"id": dataset_id, "name": name, "file": filename})

    by_id = {item["id"]: item for item in configured}
    if ANNOTATIONS_ROOT.exists():
        for directory in sorted(ANNOTATIONS_ROOT.iterdir()):
            if directory.is_dir() and directory.name not in by_id:
                by_id[directory.name] = {
                    "id": directory.name,
                    "name": directory.name,
                    "file": "",
                }
    return list(by_id.values())


def safe_annotation_path(relative_path: str) -> Path:
    if not relative_path or Path(relative_path).is_absolute():
        raise ValueError("标注文件路径无效")
    candidate = (ROOT / relative_path).resolve()
    try:
        candidate.relative_to(ANNOTATIONS_ROOT)
    except ValueError as exc:
        raise ValueError("只能修改 annotations 目录中的文件") from exc
    if candidate.suffix != ".json" or not candidate.is_file():
        raise ValueError("标注文件不存在")
    return candidate


def read_annotation(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8") as handle:
        data = json.load(handle)
    if not isinstance(data, dict):
        raise ValueError(f"{path.relative_to(ROOT)} 不是 JSON 对象")
    objects = data.get("objects", [])
    if not isinstance(objects, list):
        raise ValueError(f"{path.relative_to(ROOT)} 的 objects 不是数组")
    return data


def scan_records(dataset_id: str | None = None) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    datasets = load_dataset_config()
    allowed_ids = {item["id"] for item in datasets}
    if dataset_id is not None and dataset_id not in allowed_ids:
        raise ValueError("未知数据集")

    selected = [item for item in datasets if dataset_id is None or item["id"] == dataset_id]
    for dataset in selected:
        directory = ANNOTATIONS_ROOT / dataset["id"]
        if not directory.is_dir():
            continue
        sample_remotes: dict[int, list[str]] = {}
        sample_path = ROOT / dataset.get("file", "")
        if dataset.get("file") and sample_path.is_file():
            try:
                with sample_path.open("r", encoding="utf-8") as handle:
                    samples = json.load(handle)
                if isinstance(samples, list):
                    sample_remotes = {
                        int(sample["line"]): sample.get("remotes", [])
                        for sample in samples
                        if isinstance(sample, dict) and "line" in sample
                    }
            except (OSError, ValueError, json.JSONDecodeError):
                sample_remotes = {}
        for path in sorted(directory.glob("line_*.json")):
            match = ANNOTATION_NAME_RE.match(path.name)
            if not match:
                continue
            try:
                data = read_annotation(path)
            except (OSError, json.JSONDecodeError, ValueError) as exc:
                records.append({
                    "datasetId": dataset["id"],
                    "path": path.relative_to(ROOT).as_posix(),
                    "error": str(exc),
                })
                continue
            records.append({
                "datasetId": dataset["id"],
                "line": int(match.group(1)),
                "annotator": match.group(2),
                "path": path.relative_to(ROOT).as_posix(),
                "bboxCount": len(data.get("objects", [])),
                "remotes": data.get("remotes") or sample_remotes.get(int(match.group(1)), []),
                "hasNote": bool(str(data.get("note", "")).strip()),
                "timestamp": data.get("ts"),
                "sha256": file_sha(path),
                "data": data,
            })
    return records


def build_index() -> dict[str, Any]:
    datasets = load_dataset_config()
    records = scan_records()
    grouped: dict[str, list[dict[str, Any]]] = {item["id"]: [] for item in datasets}
    errors: list[dict[str, Any]] = []
    for record in records:
        if record.get("error"):
            errors.append(record)
        else:
            grouped.setdefault(record["datasetId"], []).append(record)

    output = []
    for dataset in datasets:
        dataset_records = grouped.get(dataset["id"], [])
        histogram = Counter(record["bboxCount"] for record in dataset_records)
        annotators = Counter(record["annotator"] for record in dataset_records)
        output.append({
            **dataset,
            "recordCount": len(dataset_records),
            "histogram": [
                {"bboxCount": count, "recordCount": histogram[count]}
                for count in sorted(histogram)
            ],
            "annotators": [
                {"name": name, "recordCount": annotators[name]}
                for name in sorted(annotators)
            ],
            "records": [
                {
                    "line": record["line"],
                    "annotator": record["annotator"],
                    "path": record["path"],
                    "bboxCount": record["bboxCount"],
                }
                for record in dataset_records
            ],
        })
    return {"datasets": output, "errors": errors}


def validate_write(item: Any) -> tuple[Path, dict[str, Any], str]:
    if not isinstance(item, dict):
        raise ValueError("保存项格式错误")
    path = safe_annotation_path(str(item.get("path", "")))
    expected_sha = str(item.get("expectedSha256", ""))
    if not expected_sha:
        raise ValueError(f"{path.relative_to(ROOT)} 缺少版本指纹")
    current_sha = file_sha(path)
    if current_sha != expected_sha:
        raise ValueError(f"{path.relative_to(ROOT)} 已被其他进程修改，请刷新后重试")

    data = item.get("data")
    if not isinstance(data, dict) or not isinstance(data.get("objects", []), list):
        raise ValueError(f"{path.relative_to(ROOT)} 的标注结构无效")
    match = ANNOTATION_NAME_RE.match(path.name)
    if not match or int(data.get("line", -1)) != int(match.group(1)):
        raise ValueError(f"{path.relative_to(ROOT)} 的 line 与文件名不一致")
    return path, data, current_sha


def save_batch(payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict) or not isinstance(payload.get("items"), list):
        raise ValueError("请求必须包含 items 数组")
    items = payload["items"]
    if not items:
        raise ValueError("没有需要保存的修改")

    validated = [validate_write(item) for item in items]
    paths = [path for path, _, _ in validated]
    if len(paths) != len(set(paths)):
        raise ValueError("同一文件不能在一个批次中保存两次")

    written = []
    for path, data, _ in validated:
        fd, temp_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
        try:
            with os.fdopen(fd, "wb") as handle:
                handle.write(json_bytes(data))
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temp_name, path)
        finally:
            if os.path.exists(temp_name):
                os.unlink(temp_name)
        written.append({
            "path": path.relative_to(ROOT).as_posix(),
            "sha256": file_sha(path),
        })
    return {"saved": len(written), "files": written}


class LocalAdminHandler(SimpleHTTPRequestHandler):
    server_version = "SpatialLocalAdmin/1.0"

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def log_message(self, fmt: str, *args: Any) -> None:
        print(f"[{self.log_date_time_string()}] {fmt % args}")

    def send_json(self, value: Any, status: HTTPStatus = HTTPStatus.OK) -> None:
        body = json.dumps(value, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def send_api_error(self, exc: Exception, status: HTTPStatus = HTTPStatus.BAD_REQUEST) -> None:
        self.send_json({"error": str(exc)}, status)

    def do_GET(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        try:
            if parsed.path == "/api/index":
                self.send_json(build_index())
                return
            if parsed.path == "/api/records":
                query = parse_qs(parsed.query)
                dataset_id = query.get("dataset", [""])[0]
                bbox_raw = query.get("bbox_count", [""])[0]
                annotator = query.get("annotator", [""])[0]
                if not dataset_id or bbox_raw == "":
                    raise ValueError("dataset 和 bbox_count 为必填项")
                bbox_count = int(bbox_raw)
                if bbox_count < 0:
                    raise ValueError("bbox_count 不能小于 0")
                records = [
                    record for record in scan_records(dataset_id)
                    if not record.get("error")
                    and record["bboxCount"] == bbox_count
                    and (not annotator or record["annotator"] == annotator)
                ]
                self.send_json({"records": records})
                return
            if parsed.path == "/":
                self.send_response(HTTPStatus.FOUND)
                self.send_header("Location", "/local-admin.html")
                self.end_headers()
                return
        except (ValueError, OSError, json.JSONDecodeError) as exc:
            self.send_api_error(exc)
            return
        super().do_GET()

    def do_POST(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        if parsed.path != "/api/save-batch":
            self.send_api_error(ValueError("接口不存在"), HTTPStatus.NOT_FOUND)
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length <= 0 or length > 50 * 1024 * 1024:
                raise ValueError("请求体为空或过大")
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
            self.send_json(save_batch(payload))
        except (ValueError, OSError, json.JSONDecodeError) as exc:
            self.send_api_error(exc)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="启动本地管理员标注修改页面")
    parser.add_argument("--host", default="127.0.0.1", help="监听地址，默认仅本机")
    parser.add_argument("--port", type=int, default=8765, help="监听端口，默认 8765")
    parser.add_argument(
        "--allow-remote",
        action="store_true",
        help="允许监听非回环地址。此工具无认证，只应在可信网络中使用",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    if args.host not in {"127.0.0.1", "localhost", "::1"} and not args.allow_remote:
        raise SystemExit("拒绝监听非本机地址。如确有需要，请显式添加 --allow-remote")
    server = ThreadingHTTPServer((args.host, args.port), LocalAdminHandler)
    print(f"本地管理员页面：http://{args.host}:{args.port}/local-admin.html")
    print("按 Ctrl+C 停止。保存操作会直接修改当前仓库 annotations 下的已有文件。")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n服务已停止")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
