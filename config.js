/**
 * 标注平台配置文件
 * 部署前请修改以下配置项
 */
window.ANNOTATE_CONFIG = {
  // ===== GitHub 仓库配置 =====
  // 标注员使用 Personal Access Token (PAT) 登录
  // PAT 权限要求：Classic PAT 勾 repo（Fine-grained 无法访问协作者仓库）
  github: {
    repoOwner: "fan-jj24",  // 仓库所有者的用户名或组织名
    repoName: "spatial-consistency-annotation",  // 仓库名
    branch: "main",  // 标注结果保存到哪个分支
    // 旧版单文件模式（annotate.html）使用的路径模板，新版批量模式不依赖此字段
    annotationsPath: "annotations/{username}.json",

    // ===== 分发模式配置 =====
    linesDir: "annotations",        // 单行标注文件目录：annotations/{datasetId}/line_XXXXXX__{username}.json
    locksDir: "locks",              // 标注锁文件目录：locks/{datasetId}/batch__{username}.json

    // ===== 审核模式配置（热更新：全新目录，不影响已有标注数据）=====
    reviewsDir: "reviews",          // 审核结果目录：reviews/{datasetId}/line_XXXXXX__{reviewerName}.json
    reviewLocksDir: "locks-review", // 审核锁目录：locks-review/{datasetId}/batch__{reviewerName}.json
  },

  // ===== 数据集列表 =====
  // 每个数据集对应一个 JSON 文件，标注员可在页面上切换
  // id:        唯一标识（用于存储路径隔离，避免不同数据集行号冲突）
  // name:      显示名称（标注员看到的）
  // file:      JSON 文件名（放在仓库根目录或 web 目录下）
  // visibleTo: 可见性名单（前端软隔离）。
  //            - ["*"] 或不填：所有人可见（共用池）
  //            - [哈希...]：只有登录 PAT 的 SHA256 哈希命中名单的人可见
  //            哈希算法：SHA256(PAT明文)，小写十六进制
  // 新增数据集时：1) 生成 JSON 文件  2) 在此数组中加一条（含 visibleTo）  3) 上传 JSON 到仓库
  datasets: [
    { id: "ds500", name: "500 条 ——0801（line 2504~13279）", file: "samples_500.json",
      visibleTo: ["a66afe3a6c09a67abcb833de04fde0a3e0635bb131dc51f032b9631f8c0cc6a9"] },
    { id: "tests100", name: "测试集 100 条（line 2504~2847）", file: "tests_100.json",
      visibleTo: ["*"] },
    { id: "ds500_1000", name: "1000条 ——0805（line 13280~15078）", file: "samples_500_1000.json",
      visibleTo: ["a66afe3a6c09a67abcb833de04fde0a3e0635bb131dc51f032b9631f8c0cc6a9"] },
    { id: "ds1000_1500", name: "500条 ——0805", file: "samples_1000_1500.json",
      visibleTo: ["d21a8e1324b281f343e56e2b61d203c38b3bd445c55642ba3012fc8f574c183d"] },
    { id: "ds1500_2000", name: "1500条 ——0806", file: "samples_1500_2000.json",
      visibleTo: ["a66afe3a6c09a67abcb833de04fde0a3e0635bb131dc51f032b9631f8c0cc6a9"] },
    { id: "ds2000_2500", name: "2000条 ——0807（line 2~7511）", file: "samples_2000_2500.json",
      visibleTo: ["a66afe3a6c09a67abcb833de04fde0a3e0635bb131dc51f032b9631f8c0cc6a9"] },
    { id: "ds2500_3000", name: "real_movies", file: "samples_2500_3000.json",
      visibleTo: ["d21a8e1324b281f343e56e2b61d203c38b3bd445c55642ba3012fc8f574c183d"] },
    { id: "ds3000_3500", name: "samples500", file: "samples_reannotate_3000_3500.json",
      visibleTo: ["*"] },
    { id: "ds3500_5000", name: "biggersamples", file: "samples_reannotate_3500_4000.json",
      visibleTo: ["*"] },
    
    // 哈希对照：
    //   a66afe3a6c09a67abcb833de04fde0a3e0635bb131dc51f032b9631f8c0cc6a9  <- PAT ghp_zTGa...（标注员A）
    //   d21a8e1324b281f343e56e2b61d203c38b3bd445c55642ba3012fc8f574c183d <- PAT ghp_jp3M...（标注员B）
    // PAT 轮换后需重新计算哈希并替换
  ],

  // ===== 默认数据集（datasets 数组的索引，0 = 第一个）=====
  defaultDataset: 0,

  // ===== 标注任务名称（显示用）=====
  taskName: "空间一致性 BBox 标注",
};

