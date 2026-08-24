# 空间一致性 BBox 标注平台

基于 GitHub 仓库的多人协作标注 + 审核平台。支持批量领取、本地标注、一次性上传，零后端、零服务器成本。

## 管理员本地分类修改

需要按 BBox 数量集中修改已有标注时，先在电脑上拉取仓库，然后在仓库根目录运行：

```bash
python3 local_admin_server.py
```

浏览器打开：

```text
http://127.0.0.1:8765/local-admin.html
```

使用流程：

1. 选择数据集。
2. 从 BBox 数量分布中选择分类，例如“2 框”。
3. 加载该分类的全部已有标注。
4. 使用与 `dispatch.html` 相同的画框、动作、2D/3D 方向和备注界面修改。
5. 点击“保存本批修改”。工具只会覆盖实际改过的已有标注文件。
6. 使用 `git diff` 检查结果，确认后自行 `git add`、`git commit` 和 `git push`。

该工具只读取和修改 `annotations`，不读取审核结论，不创建新标注文件，也不调用 GitHub API。服务默认只监听 `127.0.0.1`，没有认证功能，不要将它直接暴露到公网。

## 核心特性

- **批量模式**：一次领取 N 条到浏览器，本地标注零 API 调用，结束后一次性上传
- **双角色**：标注者（画框填动作）+ 审核者（判定正确/错误）
- **多数据集**：页面上切换不同数据集，存储路径自动隔离
- **3D 球体编辑器**：球体 + 经纬线 + 法向量箭头，带深度着色
- **手势快速填写**：双击=新增、框内划线=删除、右键=替换
- **箭头大小滑块**：前端实时调整，数据只存坐标点不受影响
- **锁可视化**：点击"锁定中"展开，查看谁在锁哪些行
- **图片固定布局**：图片对 sticky 固定在顶部，标注行可上下滚动

## 架构

```
浏览器（纯静态，部署在 GitHub Pages）
  ├── dispatch.html         ← 标注页面（批量模式，主入口）
  ├── annotate.html         ← 旧版标注页面（全量滚动模式，保留备用）
  ├── config.js             ← 配置文件（仓库地址、数据集列表等）
  ├── github-auth.js        ← PAT 认证 + 角色存储
  ├── github-dispatch.js    ← 批量分发 / 锁 / 上传 / 审核
  ├── github-storage.js     ← 旧版存储模块（annotate.html 用）
  ├── samples_500.json      ← 数据集：500 条
  └── tests_100.json        ← 数据集：测试集 100 条

GitHub 仓库
  ├── annotations/{datasetId}/   ← 标注结果（一行一个文件）
  │   └── line_002504__张三.json
  ├── reviews/{datasetId}/       ← 审核结果（一行一个文件）
  │   └── line_002504__李四.json
  ├── locks/{datasetId}/         ← 标注锁（每人一个文件）
  │   └── batch__张三.json
  └── locks-review/{datasetId}/  ← 审核锁
      └── batch__李四.json
```

## 一、管理员部署（约 10 分钟）

### 1. 创建 GitHub 仓库

新建仓库（如 `spatial-consistency-annotation`），在仓库里创建以下空目录（各放一个 `.gitkeep`）：

```
annotations/locks/reviews/locks-review/
```

### 2. 邀请标注员为 Collaborator

仓库 Settings → Collaborators → Add people → 输入对方 GitHub 用户名 → 角色 Write

对方需接受邮件邀请才能获得写入权限。

### 3. 修改 config.js

```javascript
window.ANNOTATE_CONFIG = {
  github: {
    repoOwner: "你的用户名",
    repoName: "spatial-consistency-annotation",
    branch: "main",
    linesDir: "annotations",
    locksDir: "locks",
    reviewsDir: "reviews",
    reviewLocksDir: "locks-review",
  },
  datasets: [
    { id: "ds500", name: "500 条", file: "samples_500.json" },
    { id: "tests100", name: "测试集 100 条", file: "tests_100.json" },
  ],
  defaultDataset: 0,
};
```

### 4. 生成数据集 JSON

从已有的 `annotate_xxx.html` 提取，或手动构造：

```json
[
  {
    "line": 2504,
    "remotes": [
      "https://oss-bucket.aliyuncs.com/fjj/2k/line_002504_A.jpg",
      "https://oss-bucket.aliyuncs.com/fjj/2k/line_002504_B.jpg"
    ],
    "locals": ["", ""]
  }
]
```

- `line`：唯一行号
- `remotes[0]`：A 图（参考图）URL
- `remotes[1]`：B 图（标注图）URL
- `locals`：留空

### 5. 上传并开启 GitHub Pages

把所有文件推到仓库，然后 Settings → Pages → Source 选 main 分支 → Save。

标注员访问：`https://你的用户名.github.io/仓库名/dispatch.html`

---

## 二、标注员/审核员使用

### 1. 创建 PAT

> ⚠️ 协作者**必须用 Classic token**，不能用 Fine-grained token。
> 因为 Fine-grained token 只能选自己拥有的仓库，选不了别人邀请你当协作者的仓库。

1. GitHub → 头像 → Settings → Developer settings → **Personal access tokens** → **Tokens (classic)**
2. Generate new token (classic)
3. 勾选 **`repo`**（只需这一个）
4. 生成后复制 `ghp_` 开头的字符串

### 2. 登录

1. 打开标注页面 URL
2. 点 **🔑 GitHub 登录**
3. 粘贴 PAT
4. 输入**你的名字**（作为标注/审核记录的标识）
5. 选择**角色**：✍️ 标注者 或 ⚖️ 审核者
6. 点验证并登录

角色和名字会记住，下次打开自动恢复。顶栏有角色徽章，点击可切换。

### 3. 领取任务

1. 选择**数据集**（顶栏下拉框）
2. 查看池子状态：总数 / 已完成 / 锁定中 / 可领取
3. 点击"锁定中"数字可展开查看**谁在锁哪些行**
4. 输入**领取数量**（如 10）
5. 点 **📥 领取任务**
6. 系统随机抽取指定数量，一次性锁定

### 4. 标注操作（标注者）

| 操作 | 手势 |
|------|------|
| 画框 | 在 B 图空白处拖拽 |
| 新增 (add) | 框内**双击** |
| 删除 (delete) | 框内**划线**（拖过一条线） |
| 替换 (replace) | 框上**右键** |
| 2D 移动 (move) | 下拉选 move → 框外点击设目标点 |
| 3D 移动 (move3d) | 下拉选 move3d → 弹出球体编辑器 |
| 旋转 (rotate) | 下拉选 rotate |
| 自定义文字 | 下拉选 custom → 输入描述 |
| 编辑框位置 | 点标注行最左侧 ✎ → 拖拽 / 拉 8 个手柄 |
| 撤销 | Ctrl+Z |

**3D 球体编辑器**：
- 左键拖拽 = 旋转球体
- 滚轮 = 缩放
- 🔴 亮红/粗 = 箭头朝你（出屏）
- 🔵 暗蓝/细 = 箭头远离你（入屏）
- 🟡 黄色菱形 = 箭头在球面切平面上

**箭头大小滑块**：顶栏可拖动滑块实时调整 2D/3D 箭头显示大小（0.5x~3.0x），数据只存坐标点不受影响。

**整体不一致描述**：图片对下方的文本框，描述两张图的整体不一致。

**判定"已完成"的标准**：标注者必须有框或有描述；审核者必须有判定。

### 5. 审核操作（审核者）

审核者领取的是**已标注但未审核**的数据：
- 标注结果只读展示（框、动作、描述都看得到，不能改）
- 图片对上方显示**标注者名字**
- 在审核面板选择 **✓ 正确** 或 **✗ 错误**
- 判定为错误时**必须填写原因**

### 6. 导航

- 顶栏 **← 上一条** / **下一条 →**
- 快捷键：← → 切换，Enter = 下一条
- 导航点：顶栏右侧的小方块，点击直接跳转
- 进度条：显示 `3/10 已完成`

### 7. 结束标注

点 **🏁 结束标注** → 确认弹窗：
- ✅ 已完成的条数将保存到仓库
- ↩️ 未完成的条数将返回池子
- 点确定后：上传已完成的 → 释放当前角色的锁 → 清空本地记录 → 回到领取界面

> 结束只释放**当前角色**的锁。如果你同时在标注和审核都有任务，结束标注不会影响审核锁。

---

## 三、数据结构

### 标注结果

```
annotations/{datasetId}/line_XXXXXX__{username}.json
```

```json
{
  "line": 2504,
  "remotes": ["url_A", "url_B"],
  "objects": [
    {
      "box": { "x": 100, "y": 200, "w": 150, "h": 180 },
      "type": "move3d",
      "dir3d": [0.5, 0.3, -0.8]
    },
    {
      "box": { "x": 300, "y": 400, "w": 120, "h": 90 },
      "type": "delete",
      "line": [{ "x": 310, "y": 410 }, { "x": 400, "y": 480 }]
    }
  ],
  "note": "整体背景色调不一致"
}
```

### 审核结果

```
reviews/{datasetId}/line_XXXXXX__{reviewerName}.json
```

```json
{
  "line": 2504,
  "verdict": "wrong",
  "reason": "3D移动方向应为朝向观察者，但标注为远离",
  "annotator": "张三",
  "reviewer": "李四",
  "ts": 1722470400000
}
```

### 锁文件

```
locks/{datasetId}/batch__{username}.json
```

```json
{
  "username": "张三",
  "lines": [2504, 2505, 2506],
  "ts": 1722470400000
}
```

---

## 四、回收数据

```bash
git clone https://github.com/你的用户名/spatial-consistency-annotation.git
# annotations/{datasetId}/  → 标注数据
# reviews/{datasetId}/       → 审核数据
```

每个文件是一行的标注/审核结果，文件名格式 `line_XXXXXX__标注员名字.json`。

---

## 五、文件清单

| 文件 | 说明 |
|------|------|
| `dispatch.html` | **主标注页面**（批量模式、双角色、3D 球体编辑器、手势） |
| `config.js` | 配置文件（仓库地址、数据集列表、审核目录） |
| `github-auth.js` | PAT 认证 + 标注员名字 + 角色存储 |
| `github-dispatch.js` | 批量分发 / 锁 / 上传 / 审核 |
| `github-storage.js` | 旧版存储模块（annotate.html 用） |
| `annotate.html` | 旧版标注页面（全量滚动模式，保留备用） |
| `samples_500.json` | 数据集：500 条（line 2504~13279） |
| `tests_100.json` | 数据集：测试集 100 条（line 2504~2847） |
| `samples.json` | 数据集模板（2 条示例） |
| `README.md` | 本教程 |

---

## 六、常见问题

**Q: Fine-grained token 选不了别人的仓库？**
A: 这是 GitHub 的限制。Fine-grained token 只能操作自己拥有的仓库。协作者必须用 **Classic token**（勾选 `repo` scope）。

**Q: 标注员看不到图片？**
A: 确认 OSS 图片 URL 是公开可访问的，没有防盗链或签名过期。

**Q: 保存/上传时报 403？**
A: PAT 权限不足。Classic token 需勾选 `repo` scope；确认已接受仓库 collaborator 邀请。

**Q: 结束标注后还有锁？**
A: 检查 `locks/{datasetId}/` 目录。正常情况下结束标注会删除当前角色的锁文件。如果之前清了浏览器缓存但没结束标注，锁会残留——重新登录领取任务时会自动检测并恢复。

**Q: 能否不登录就标注？**
A: 不行。批量模式需要先登录才能查看池子统计和领取任务。

**Q: 如何新增数据集？**
A: 三步：1) 生成 JSON 文件 → 2) 在 `config.js` 的 `datasets` 数组加一条 → 3) 上传到仓库。

**Q: GitHub Pages 构建显示 "cancelled"？**
A: 正常现象。连续推多次提交时，后面的提交会取消前面的构建。数据已保存，等最后一次构建变绿即可。

**Q: 清空浏览器缓存怎么操作？**
A: F12 → Console → `localStorage.clear()` → 刷新。注意：清缓存不会释放仓库里的锁。
