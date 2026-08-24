#!/usr/bin/env python3
"""
从标注数据生成 JSONL 数据集

功能：
  - 默认读取仓库中的 8 个正式数据集（不包含 tests100）
  - 下载原始图片对（A + B）
  - 在 B 图上渲染标注（bbox、箭头、线条、文字标签）
  - 上传标注后的 B 图到外网 OSS，获取 URL
  - 生成 JSONL，每行包含：
    - line: 行号
    - image_a_url: 原始 A 图 URL
    - image_b_url: 原始 B 图 URL
    - annotated_b_url: 标注后的 B 图 URL
    - note: 整体不一致描述
    - bg_global: 是否整体背景不一致
    - bg_ambiguous: 是否无法判断/一致
    - objects: [{box, type, target, dir3d, text, line}, ...]

用法：
  python3 gen_jsonl.py --output dataset.jsonl
  python3 gen_jsonl.py --override-dir annotation-override --output dataset.jsonl
  python3 gen_jsonl.py --output dataset.jsonl --datasets ds500,ds500_1000
  python3 gen_jsonl.py --output dataset.jsonl --skip-upload  # 只保存本地不上传
"""

import argparse
import hashlib
import json
import os
import sys
import io
import time
import re
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor, as_completed

try:
    from PIL import Image, ImageDraw, ImageFont
except ImportError:
    print("请先安装 Pillow: pip install Pillow")
    sys.exit(1)

try:
    import requests
except ImportError:
    print("请先安装 requests: pip install requests")
    sys.exit(1)

# ===== OSS =====
OUTER_OSS_PREFIX = "yk/ai-material/neo/fjj/2k/annotated"
SCRIPT_DIR = Path(__file__).resolve().parent
DEFAULT_DATASETS = (
    "ds500,ds500_1000,ds1000_1500,ds1500_2000,"
    "ds2000_2500,ds2500_3000,ds3000_3500,ds3500_5000"
)

def build_outer_handler():
    """从环境变量构建 OSS handler（参考 interactive_selector.py）"""
    ak = os.environ.get("OUTER_OSS_ACCESS_KEY_ID", "")
    sk = os.environ.get("OUTER_OSS_ACCESS_KEY_SECRET", "")
    ep = os.environ.get("OUTER_OSS_ENDPOINT", "")
    bn = os.environ.get("OUTER_OSS_BUCKET_NAME", "")
    if not (ak and sk and ep and bn):
        return None
    import oss2
    auth = oss2.Auth(ak, sk)
    bucket = oss2.Bucket(auth, ep, bn)
    return bucket

# ===== 颜色（与 dispatch.html ACTION_COLORS 一致）=====
ACTION_COLORS = {
    "add":     ["#2E7D32", "#4CAF50", "#81C784", "#A5D6A7"],
    "delete":  ["#C62828", "#E53935", "#EF5350", "#EF9A9A"],
    "replace": ["#795548", "#8D6E63", "#A1887F", "#BCAAA4"],
    "move":    ["#1565C0", "#2196F3", "#64B5F6", "#90CAF9"],
    "move3d":  ["#6A1B9A", "#8E24AA", "#AB47BC", "#CE93D8"],
    "rotate":  ["#E65100", "#FF9800", "#FFB74D", "#FFCC80"],
    "cw":      ["#E65100", "#FF9800", "#FFB74D", "#FFCC80"],
    "ccw":     ["#E65100", "#FF9800", "#FFB74D", "#FFCC80"],
    "neutral": ["#FFC107", "#FFB300", "#FFA000", "#FF8F00"],
    "custom":  ["#5D4037", "#795548", "#8D6E63", "#A1887F"],
    "bg_local":["#009688", "#26A69A", "#4DB6AC", "#80CBC4"],
}

ACTION_LABELS = {
    "add": "新增", "delete": "删除", "replace": "替换", "move": "2D移动",
    "rotate": "旋转", "cw": "旋转", "ccw": "旋转", "move3d": "3D移动",
    "custom": "自定义文字", "neutral": "未指定", "bg_local": "局部背景",
}

# ===== 字体 =====
_font_cache = {}
def get_font(size):
    if size not in _font_cache:
        try:
            _font_cache[size] = ImageFont.truetype("/usr/share/fonts/wqy/wqy-zenhei.ttc", size)
        except Exception:
            try:
                _font_cache[size] = ImageFont.truetype("/usr/share/fonts/opentype/noto/NotoSerifCJK-Bold.ttc", size)
            except Exception:
                _font_cache[size] = ImageFont.load_default()
    return _font_cache[size]

def hex_to_rgb(hex_color):
    h = hex_color.lstrip("#")
    return tuple(int(h[i:i+2], 16) for i in (0, 2, 4))

# ===== 读取标注记录 =====
def load_annotation_records(repo_dir, override_dir, dataset_ids):
    """
    读取指定数据集的全部标注记录
    override 优先：如果 override 目录有同名文件，用 override 的
    同一个 line 如果有多个标注者，会分别保留为独立记录
    """
    from pathlib import Path
    import json
    import re

    repo_dir = Path(repo_dir)
    override_dir = Path(override_dir) if override_dir else None
    records = []

    for ds_id in dataset_ids:
        anno_dir_repo = repo_dir / "annotations" / ds_id
        if not anno_dir_repo.is_dir():
            print("  ⚠️ 数据集 " + ds_id + " 的标注目录不存在: " + str(anno_dir_repo))
            continue

        for f in sorted(anno_dir_repo.glob("*.json")):
            rel_path = f.relative_to(repo_dir).as_posix()

            # override 优先
            data = None
            source = "repo"
            if override_dir:
                override_file = override_dir / rel_path
                if override_file.is_file():
                    try:
                        with open(override_file, "r", encoding="utf-8") as of:
                            data = json.load(of)
                        source = "override"
                    except Exception:
                        pass

            if data is None:
                try:
                    with open(f, "r", encoding="utf-8") as rf:
                        data = json.load(rf)
                except Exception:
                    continue

            # 从文件名提取标注者
            m = re.match(r"line_(\d+)__(.+)\.json$", f.name)
            if m:
                line = int(m.group(1))
                annotator = m.group(2)
            else:
                continue

            records.append({
                "line": line,
                "dataset_id": ds_id,
                "annotator": annotator,
                "annotation": data,
                "source": source,
                "file_path": rel_path,
            })

    records.sort(key=lambda r: (r["dataset_id"], r["line"], r["annotator"]))
    return records

# ===== 读取审核记录 =====
def load_review_records(repo_dir, override_dir, dataset_ids):
    """读取审核记录，按 (dataset_id, line) 索引"""
    from pathlib import Path
    import json
    import re

    repo_dir = Path(repo_dir)
    override_dir = Path(override_dir) if override_dir else None
    reviews = {}

    for ds_id in dataset_ids:
        review_dir_repo = repo_dir / "reviews" / ds_id
        if not review_dir_repo.is_dir():
            continue

        for f in sorted(review_dir_repo.glob("*.json")):
            rel_path = f.relative_to(repo_dir).as_posix()
            data = None
            if override_dir:
                override_file = override_dir / rel_path
                if override_file.is_file():
                    try:
                        with open(override_file, "r", encoding="utf-8") as of:
                            data = json.load(of)
                    except Exception:
                        pass
            if data is None:
                try:
                    with open(f, "r", encoding="utf-8") as rf:
                        data = json.load(rf)
                except Exception:
                    continue

            m = re.match(r"line_(\d+)__(.+)\.json$", f.name)
            if m:
                line = int(m.group(1))
                key = (ds_id, line)
                if key not in reviews:
                    reviews[key] = data
    return reviews

# ===== 读取 samples（获取 remotes）=====
def load_samples(repo_dir, dataset_ids):
    """从 samples JSON 读取 remotes"""
    from pathlib import Path
    import json
    import re

    repo_dir = Path(repo_dir)
    sample_by_line = {}

    # 从 config.js 读数据集 file 映射
    config_path = repo_dir / "config.js"
    ds_file_map = {}
    if config_path.is_file():
        with open(config_path, "r", encoding="utf-8") as f:
            text = f.read()
        for m in re.finditer(r'id:\s*"([^"]+)"\s*,\s*name:\s*"([^"]+)"\s*,\s*file:\s*"([^"]+)"', text):
            ds_file_map[m.group(1)] = m.group(3)

    for ds_id in dataset_ids:
        file_name = ds_file_map.get(ds_id, "samples_" + ds_id + ".json")
        # 在仓库根或 web 目录找
        for p in [repo_dir / file_name, repo_dir / "web" / file_name]:
            if p.is_file():
                try:
                    with open(p, "r", encoding="utf-8") as f:
                        samples = json.load(f)
                    for s in samples:
                        sample_by_line[(ds_id, s["line"])] = s
                except Exception:
                    pass
                break

    return sample_by_line

# ===== 下载图片 =====
def download_image(url, timeout=30):
    """下载图片，返回 PIL Image 对象"""
    resp = requests.get(url, timeout=timeout)
    if resp.status_code != 200:
        raise Exception("下载失败 HTTP " + str(resp.status_code) + ": " + url[:80])
    return Image.open(io.BytesIO(resp.content)).convert("RGB")

# ===== 在图片上渲染标注 =====
def render_annotation_on_image(img, annotation):
    """
    在 B 图上渲染标注
    - 画 bbox
    - 画箭头（move 的 target）
    - 画线条（delete 的 line）
    - 画文字标签
    - 画背景斜线（bg_global / bg_ambiguous）
    """
    draw = ImageDraw.Draw(img, "RGBA")
    w, h = img.size

    # 整体背景不一致：斜线覆盖
    if annotation.get("bg_global"):
        _draw_diagonal_overlay(draw, w, h, (0, 150, 136, 60), 45)
    if annotation.get("bg_ambiguous"):
        _draw_diagonal_overlay(draw, w, h, (136, 136, 136, 50), -45)

    objects = annotation.get("objects", [])
    color_idx = {}

    for i, obj in enumerate(objects):
        box = obj.get("box", {})
        bx, by = box.get("x", 0), box.get("y", 0)
        bw, bh = box.get("w", 0), box.get("h", 0)
        obj_type = obj.get("type", "neutral")

        # 获取颜色
        shades = ACTION_COLORS.get(obj_type, ACTION_COLORS["neutral"])
        idx = color_idx.get(obj_type, 0)
        color = hex_to_rgb(shades[idx % len(shades)])
        color_idx[obj_type] = idx + 1

        # 画 bbox
        if bw > 0 and bh > 0:
            draw.rectangle([bx, by, bx + bw, by + bh], outline=color, width=3)

        # 编号标签
        label = "#" + str(i + 1)
        font = get_font(max(14, min(20, int(bh * 0.15))))
        label_w = draw.textlength(label, font=font)
        label_h = font.size + 4
        draw.rectangle([bx, by - label_h, bx + label_w + 8, by], fill=color)
        draw.text((bx + 4, by - label_h + 2), label, fill=(255, 255, 255), font=font)

        # 画箭头（move）
        if obj.get("target") and obj_type == "move":
            tx, ty = obj["target"].get("x", 0), obj["target"].get("y", 0)
            cx, cy = bx + bw / 2, by + bh / 2
            _draw_arrow(draw, cx, cy, tx, ty, color)

        # 画线条（delete）
        if obj.get("line") and obj_type == "delete":
            l = obj["line"]
            if len(l) >= 2:
                _draw_line(draw, l[0]["x"], l[0]["y"], l[1]["x"], l[1]["y"], color)

        # 画文字标签（type + custom text）
        type_label = ACTION_LABELS.get(obj_type, obj_type)
        if obj.get("text"):
            type_label = type_label + ": " + obj["text"]
        if obj.get("dir3d"):
            d = obj["dir3d"]
            type_label = type_label + " [" + str(round(d[0], 2)) + "," + str(round(d[1], 2)) + "," + str(round(d[2], 2)) + "]"

        tag_font = get_font(12)
        tag_w = draw.textlength(type_label, font=tag_font)
        tag_h = tag_font.size + 4
        tag_y = by + bh + 2
        if tag_y + tag_h > h:
            tag_y = by - tag_h - label_h - 2
        draw.rectangle([bx, tag_y, bx + tag_w + 8, tag_y + tag_h], fill=color)
        draw.text((bx + 4, tag_y + 2), type_label, fill=(255, 255, 255), font=tag_font)

    return img

def _draw_diagonal_overlay(draw, w, h, color, angle):
    """画斜线覆盖"""
    spacing = 12
    if angle > 0:
        for x in range(-h, w + h, spacing):
            draw.line([(x, 0), (x + h, h)], fill=color, width=3)
    else:
        for x in range(-h, w + h, spacing):
            draw.line([(x, h), (x + h, 0)], fill=color, width=3)

def _draw_arrow(draw, x1, y1, x2, y2, color, head_size=10):
    """画箭头"""
    import math
    draw.line([(x1, y1), (x2, y2)], fill=color, width=3)
    angle = math.atan2(y2 - y1, x2 - x1)
    for da in [2.6, -2.6]:
        hx = x2 + head_size * math.cos(angle + da)
        hy = y2 + head_size * math.sin(angle + da)
        draw.line([(x2, y2), (hx, hy)], fill=color, width=3)

def _draw_line(draw, x1, y1, x2, y2, color):
    """画线条"""
    draw.line([(x1, y1), (x2, y2)], fill=color, width=3)

# ===== 上传到 OSS =====
def upload_to_oss(bucket, oss_key, img, format="JPEG", quality=90):
    """上传 PIL Image 到 OSS，返回签名 URL"""
    buf = io.BytesIO()
    img.save(buf, format=format, quality=quality)
    buf.seek(0)
    bucket.put_object(oss_key, buf)

    # 生成签名 URL（有效期极长）
    url = bucket.sign_url("GET", oss_key, 3600000000000)
    return url

def is_oss_file_exist(bucket, oss_key):
    """检查 OSS 上文件是否已存在"""
    try:
        return bucket.object_exists(oss_key)
    except Exception:
        return False

def safe_key_component(value):
    """将标注者名称转换为稳定且适合放入 OSS Key 的片段。"""
    value = str(value)
    slug = re.sub(r"[^0-9A-Za-z._-]+", "_", value).strip("._-") or "annotator"
    digest = hashlib.sha256(value.encode("utf-8")).hexdigest()[:8]
    return slug[:48] + "-" + digest

def annotation_content_hash(annotation):
    """计算稳定的标注内容哈希；忽略时间戳和可能变化的图片签名 URL。"""
    content = {
        "objects": annotation.get("objects", []),
        "note": annotation.get("note", ""),
        "bg_global": annotation.get("bg_global", False),
        "bg_ambiguous": annotation.get("bg_ambiguous", False),
    }
    encoded = json.dumps(
        content, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()[:16]

def build_annotated_image_path(record):
    """构建不会在数据集、标注者或标注版本之间冲突的相对图片路径。"""
    file_name = "line_{:06d}__{}__{}.jpg".format(
        record["line"],
        safe_key_component(record["annotator"]),
        annotation_content_hash(record["annotation"]),
    )
    return Path(record["dataset_id"]) / file_name

# ===== 主流程 =====
def process_one_record(record, sample, review, bucket, skip_upload, local_dir):
    """处理一条记录：下载图片 → 渲染标注 → 上传 → 返回 JSONL 行"""
    line = record["line"]
    annotation = record["annotation"]
    remotes = sample["remotes"] if sample else annotation.get("remotes", [])

    if len(remotes) < 2:
        return None, Exception("line " + str(line) + ": 缺少 remotes")

    url_a = remotes[0]
    url_b = remotes[1]

    try:
        # 下载 B 图
        img_b = download_image(url_b)

        # 渲染标注
        img_annotated = render_annotation_on_image(img_b.copy(), annotation)

        # 上传或保存本地
        annotated_url = ""
        image_rel_path = build_annotated_image_path(record)
        if skip_upload:
            local_path = Path(local_dir) / image_rel_path
            local_path.parent.mkdir(parents=True, exist_ok=True)
            img_annotated.save(str(local_path), "JPEG", quality=90)
            annotated_url = str(local_path)
        else:
            if not bucket:
                raise Exception("OSS 未配置")
            oss_key = OUTER_OSS_PREFIX + "/" + image_rel_path.as_posix()
            if not is_oss_file_exist(bucket, oss_key):
                annotated_url = upload_to_oss(bucket, oss_key, img_annotated)
            else:
                annotated_url = bucket.sign_url("GET", oss_key, 3600000000000)

    except Exception as e:
        return None, e

    # 构建 JSONL 行
    objects_out = []
    for obj in annotation.get("objects", []):
        obj_out = {
            "box": obj.get("box", {}),
            "type": obj.get("type", "neutral"),
        }
        if obj.get("target"):
            obj_out["target"] = obj["target"]
        if obj.get("dir3d"):
            obj_out["dir3d"] = obj["dir3d"]
        if obj.get("text"):
            obj_out["text"] = obj["text"]
        if obj.get("line"):
            obj_out["line"] = obj["line"]
        objects_out.append(obj_out)

    row = {
        "line": line,
        "dataset_id": record["dataset_id"],
        "annotator": record["annotator"],
        "image_a_url": url_a,
        "image_b_url": url_b,
        "annotated_b_url": annotated_url,
        "note": annotation.get("note", ""),
        "bg_global": annotation.get("bg_global", False),
        "bg_ambiguous": annotation.get("bg_ambiguous", False),
        "objects": objects_out,
        "source": record["source"],
    }

    if review:
        row["review_verdict"] = review.get("verdict", "")
        row["review_reason"] = review.get("reason", "")
        row["reviewer"] = review.get("reviewer", "")

    return row, None

def main():
    parser = argparse.ArgumentParser(description="从标注数据生成 JSONL 数据集")
    parser.add_argument(
        "--repo-dir", default=str(SCRIPT_DIR),
        help="仓库目录（默认：gen_jsonl.py 所在目录）",
    )
    parser.add_argument(
        "--override-dir", default=None,
        help="override 目录（默认：仓库目录内的 annotation-override）",
    )
    parser.add_argument("--output", "-o", default="dataset.jsonl", help="输出 JSONL 文件")
    parser.add_argument("--datasets", default=DEFAULT_DATASETS,
                        help="数据集 ID 列表（逗号分隔）")
    parser.add_argument("--skip-upload", action="store_true", help="只保存本地不上传 OSS")
    parser.add_argument("--local-dir", default="./tmp/annotated_images", help="本地保存目录（skip-upload 时用）")
    parser.add_argument("--workers", type=int, default=4, help="并发下载数")
    args = parser.parse_args()

    repo_dir = Path(args.repo_dir)
    override_dir = (
        Path(args.override_dir) if args.override_dir is not None
        else repo_dir / "annotation-override"
    )
    dataset_ids = [d.strip() for d in args.datasets.split(",") if d.strip()]
    output_path = Path(args.output)

    print("=" * 60)
    print("  📦 标注数据 → JSONL 生成器")
    print("=" * 60)
    print("  仓库目录: " + str(repo_dir))
    print("  Override: " + (str(override_dir) if override_dir else "无"))
    print("  数据集: " + str(dataset_ids))
    print("  输出: " + str(output_path))
    print("  上传: " + ("跳过（保存本地）" if args.skip_upload else "OSS"))
    print()

    # 1. 读取标注记录
    print("[1/4] 读取标注记录...")
    records = load_annotation_records(repo_dir, override_dir, dataset_ids)
    print("  共 " + str(len(records)) + " 条标注记录")

    if not records:
        print("  ❌ 没有标注记录，退出")
        return

    # 2. 读取 samples（获取 remotes）
    print("[2/4] 读取 samples...")
    sample_by_line = load_samples(repo_dir, dataset_ids)
    print("  共 " + str(len(sample_by_line)) + " 条 samples")

    # 3. 读取审核记录
    print("[3/4] 读取审核记录...")
    reviews = load_review_records(repo_dir, override_dir, dataset_ids)
    print("  共 " + str(len(reviews)) + " 条审核记录")

    # 4. 构建 OSS handler
    bucket = None
    if not args.skip_upload:
        print("[4/4] 初始化 OSS...")
        bucket = build_outer_handler()
        if bucket:
            print("  ✅ OSS 已配置")
        else:
            print("  ⚠️ OSS 未配置（环境变量缺失），将保存到本地")
            args.skip_upload = True

    # 处理每条记录
    print("\n[process] 开始处理 " + str(len(records)) + " 条记录...")
    local_dir = args.local_dir

    results = []
    errors = []
    done = [0]

    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        futures = {}
        for record in records:
            record_key = (record["dataset_id"], record["line"])
            sample = sample_by_line.get(record_key)
            review = reviews.get(record_key)
            fut = pool.submit(process_one_record, record, sample, review, bucket, args.skip_upload, local_dir)
            futures[fut] = record

        for fut in as_completed(futures):
            record = futures[fut]
            row, err = fut.result()
            done[0] += 1
            if err:
                errors.append((record["line"], str(err)))
                if len(errors) <= 5:
                    print("  ❌ line " + str(record["line"]) + ": " + str(err))
            else:
                results.append(row)

            if done[0] % 50 == 0 or done[0] == len(records):
                print("  进度: " + str(done[0]) + "/" + str(len(records)) + " 成功=" + str(len(results)) + " 失败=" + str(len(errors)))

    # 按行号排序
    results.sort(key=lambda r: (r["dataset_id"], r["line"], r["annotator"]))

    # 写 JSONL
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with open(output_path, "w", encoding="utf-8") as f:
        for row in results:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")

    print("\n" + "=" * 60)
    print("  ✅ 完成！")
    print("  输出: " + str(output_path))
    print("  成功: " + str(len(results)) + " 条")
    print("  失败: " + str(len(errors)) + " 条")
    if errors:
        print("  失败详情（前10条）:")
        for line, err in errors[:10]:
            print("    line " + str(line) + ": " + str(err))
    print("=" * 60)

if __name__ == "__main__":
    main()
