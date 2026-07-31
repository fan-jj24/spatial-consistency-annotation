/**
 * 标注平台配置文件
 * 部署前请修改以下配置项
 */
window.ANNOTATE_CONFIG = {
  // ===== GitHub 仓库配置 =====
  // 标注员使用 Personal Access Token (PAT) 登录
  // PAT 权限要求：Fine-grained → Contents (Read and Write)
  github: {
    repoOwner: "fan-jj24",  // 仓库所有者的用户名或组织名
    repoName: "spatial-consistency-annotation",  // 仓库名
    branch: "main",  // 标注结果保存到哪个分支
    // 标注文件保存路径模板，{username} 会被替换为标注员的 GitHub 用户名
    annotationsPath: "annotations/{username}.json",

    // ===== 分发模式配置 =====
    linesDir: "annotations",        // 单行标注文件目录：annotations/line_XXXXXX__{username}.json
    locksDir: "locks",              // 锁文件目录：locks/line_XXXXXX.json
    lockTTLMinutes: 30,             // 锁超时时间（分钟），超时视为过期可被抢占
  },

  // ===== 数据集列表 =====
  // 每个数据集对应一个 JSON 文件，标注员可在页面上切换
  // id:   唯一标识（用于存储路径隔离，避免不同数据集行号冲突）
  // name: 显示名称（标注员看到的）
  // file: JSON 文件名（放在仓库根目录或 web 目录下）
  // 新增数据集时：1) 生成 JSON 文件  2) 在此数组中加一条  3) 上传 JSON 到仓库
  datasets: [
    { id: "ds500", name: "500 条（line 2504~13279）", file: "samples_500.json" },
    // 示例：后续新增数据集只需在此追加
    // { id: "ds1000", name: "第二批 1000 条", file: "samples_1000.json" },
    // { id: "dstest", name: "测试集 50 条", file: "samples_test.json" },
  ],

  // ===== 默认数据集（datasets 数组的索引，0 = 第一个）=====
  defaultDataset: 0,

  // ===== 标注任务名称（显示用）=====
  taskName: "空间一致性 BBox 标注",
};
