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

  // ===== 样本数据文件 =====
  samplesFile: "samples.json",

  // ===== 标注任务名称（显示用）=====
  taskName: "空间一致性 BBox 标注",
};
