# 空间一致性 BBox 标注平台（公共版）

基于 GitHub 仓库的多人协作标注平台。标注员通过浏览器访问网页，用 GitHub PAT 登录，标注结果自动保存到 GitHub 仓库。

## 架构

```
标注员浏览器
  ├── annotate.html      ← 标注页面（3D 球体编辑器、画框、手势等）
  ├── config.js          ← 配置文件（仓库地址等）
  ├── github-auth.js     ← PAT 认证模块
  ├── github-storage.js  ← GitHub Contents API 读写模块
  └── samples.json       ← 样本数据（图片 URL 列表）

GitHub 仓库
  └── annotations/
      ├── alice.json     ← 标注员 alice 的标注结果
      ├── bob.json       ← 标注员 bob 的标注结果
      └── ...
```

## 一、管理员部署（一次性）

### 1. 创建 GitHub 仓库

在 GitHub 上新建一个仓库（如 `spatial-consistency-annotation`），确保：
- 仓库中有一个 `annotations/` 目录（可以先放一个 `.gitkeep` 文件）
- 标注员对该仓库有 **write** 权限（如果是组织仓库，把标注员加为 collaborator）

### 2. 生成样本数据

用已有的脚本生成 `samples.json`：

```bash
# 从外网 OSS 的 fjj/2k/ 目录生成
python3 regen_html.py --output /dev/null  # 仅用于确认 OSS 连通性

# 或者手动构造 samples.json，格式如下：
```

`samples.json` 格式：

```json
[
  {
    "line": 1,
    "remotes": [
      "https://ykanimate-res.oss-cn-hangzhou.aliyuncs.com/fjj/2k/line_000001_A.jpg",
      "https://ykanimate-res.oss-cn-hangzhou.aliyuncs.com/fjj/2k/line_000001_B.jpg"
    ],
    "locals": ["", ""]
  }
]
```

- `line`：行号（唯一标识）
- `remotes[0]`：A 图（参考图）URL
- `remotes[1]`：B 图（待标注图）URL
- `locals`：留空即可（公共版不使用本地图片）

### 3. 修改配置文件

编辑 `config.js`：

```javascript
window.ANNOTATE_CONFIG = {
  github: {
    repoOwner: "your-username",        // ← 改成你的 GitHub 用户名或组织名
    repoName: "spatial-consistency-annotation",  // ← 改成你的仓库名
    branch: "main",
    annotationsPath: "annotations/{username}.json",
  },
  samplesFile: "samples.json",
  taskName: "空间一致性 BBox 标注",
};
```

### 4. 部署到 GitHub Pages

把 `web/` 目录下的所有文件推送到仓库，然后开启 GitHub Pages：

```bash
# 方式一：直接推到仓库根目录
cp web/* your-repo/
cd your-repo
git add . && git commit -m "部署标注平台" && git push

# 方式二：推到 docs/ 目录（GitHub Pages 支持从 docs/ 发布）
mkdir -p docs && cp web/* docs/
git add docs && git commit -m "部署标注平台" && git push
```

然后在仓库 Settings → Pages → Source 选择对应分支和目录。

部署完成后，标注员访问：`https://your-username.github.io/your-repo/annotate.html`

> **注意**：GitHub Pages 是 HTTPS 的，`fetch` 加载 `samples.json` 和调用 GitHub API 都不会有混合内容问题。

## 二、标注员使用

### 1. 创建 GitHub PAT

每个标注员需要创建一个 Personal Access Token：

1. 打开 GitHub → 右上角头像 → **Settings**
2. 左侧栏最底部 → **Developer settings**
3. **Personal access tokens** → **Fine-grained tokens** → **Generate new token**
4. 填写：
   - Token name：`标注平台`（随意）
   - Expiration：选择合适时长
   - Repository access：选 **Only select repositories** → 选择标注仓库
   - Permissions → Repository permissions → **Contents** → 选 **Read and Write**
5. 点 **Generate token**，复制 token（以 `github_pat_` 开头）

> 也可以用 Classic token（勾选 `repo` scope），但 Fine-grained 更安全。

### 2. 登录标注平台

1. 打开标注页面 URL
2. 点击右上角 **🔑 GitHub 登录**
3. 粘贴 PAT，点 **验证并登录**
4. 登录成功后，右上角显示头像和用户名

### 3. 标注操作

标注操作与原版完全一致：

| 操作 | 手势 |
|------|------|
| 画框 | 在 B 图上拖拽 |
| 新增 (add) | 框内双击 |
| 删除 (delete) | 框内划线 |
| 替换 (replace) | 右键点击框 |
| 2D 移动 (move) | 框外点击目标位置 |
| 旋转 (cw/ccw) | 框内上方旋转图标（左键=顺时针，Shift+左键=逆时针） |
| 3D 移动 (move3d) | 框内下方 🌐 图标，弹出 3D 球体编辑器 |
| 局部背景 | 点"局部背景"按钮后画框 |
| 整体背景 | 点"整体背景"按钮 |
| 自定义 | 动作输入框打字 + 保存 |

### 4. 保存

- **☁ 云端保存**：手动保存到 GitHub 仓库（推荐）
- **自动保存**：标注变更后 10 秒自动保存到 GitHub（静默，不打断操作）
- **💾 本地保存**：保存到浏览器 localStorage（离线备份）
- **⬇ 导出 JSON / 📦 导出压缩包**：下载到本地

### 5. 进度恢复

- 登录后自动从 GitHub 加载已有标注进度
- 换设备、清缓存后重新登录即可恢复
- 未登录时使用本地 localStorage 的进度

## 三、回收标注数据

所有标注结果保存在仓库的 `annotations/` 目录下，每个标注员一个 JSON 文件：

```
annotations/
├── alice.json
├── bob.json
└── charlie.json
```

JSON 格式与原版导出格式一致：

```json
[
  {
    "line": 1,
    "objects": [
      {
        "box": { "x": 100, "y": 200, "w": 150, "h": 180 },
        "type": "move3d",
        "dir3d": [0.5, 0.3, -0.8]
      }
    ],
    "note": "可选备注"
  }
]
```

回收方式：

```bash
# 直接 git clone 仓库
git clone https://github.com/your-username/spatial-consistency-annotation.git

# 或者用 GitHub API 批量下载
# annotations/ 目录下的所有 .json 文件就是全部标注数据
```

后续可以用 `export_jsonl.py` 把 JSON 转成带签名 URL 的 jsonl 格式。

## 四、文件清单

| 文件 | 说明 |
|------|------|
| `annotate.html` | 标注页面主文件（含 3D 球体编辑器） |
| `config.js` | 配置文件（仓库地址、分支等） |
| `github-auth.js` | GitHub PAT 认证模块 |
| `github-storage.js` | GitHub Contents API 读写模块 |
| `samples.json` | 样本数据（需替换为真实数据） |
| `README.md` | 本教程 |

## 五、常见问题

**Q: 标注员看不到图片？**
A: 确认 OSS 图片 URL 是公开可访问的。如果 OSS 有防盗链或签名过期，需要重新生成 URL。

**Q: 保存时报 403？**
A: PAT 权限不足。确认 token 有目标仓库的 Contents (Read and Write) 权限。

**Q: 保存时报 409 冲突？**
A: 同一标注员在两个设备同时标注。系统会自动重新加载云端数据，以云端为准。

**Q: 能否不登录就标注？**
A: 可以。不登录时标注数据保存在浏览器本地，用"导出 JSON"下载后手动汇总。但无法使用云端保存和进度恢复。

**Q: 如何给标注员分配不同的样本？**
A: 当前版本所有标注员看到相同的样本列表。如需分配，可以生成多份 `samples.json`（如 `samples_batch1.json`），在 `config.js` 中切换，或部署多个页面实例。
