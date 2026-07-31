/**
 * GitHub 仓库存储模块
 * 通过 GitHub Contents API 读写仓库中的标注文件
 *
 * 功能：
 * - 保存标注结果到 annotations/{username}.json
 * - 加载自己的已有标注进度
 * - 列出所有标注文件
 */

(function () {
  "use strict";

  const CONFIG = window.ANNOTATE_CONFIG.github;
  const API_BASE = "https://api.github.com";

  function authHeaders() {
    const token = window.GithubAuth.getToken();
    if (!token) throw new Error("未登录，请先登录 GitHub");
    return {
      "Accept": "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Authorization": "Bearer " + token,
    };
  }

  function annotationPath(username) {
    return CONFIG.annotationsPath.replace("{username}", username);
  }

  // ===== Base64 UTF-8 安全编解码 =====
  // btoa/atob 只支持 Latin1，中文等多字节字符会出错
  // 用 TextEncoder/TextDecoder 做 UTF-8 ↔ bytes 转换

  function utf8ToBase64(str) {
    const bytes = new TextEncoder().encode(str);
    let binary = "";
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }

  function base64ToUtf8(b64) {
    const binary = atob(b64.replace(/\n/g, ""));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return new TextDecoder().decode(bytes);
  }

  /**
   * 获取自己的标注文件（含 sha 和解析后的内容）
   * 返回 { sha, data } 或 null（文件不存在时）
   */
  async function loadMyAnnotations() {
    const user = window.GithubAuth.getUser();
    if (!user) throw new Error("未登录");
    const path = annotationPath(user.login);
    const url = API_BASE + "/repos/" + CONFIG.repoOwner + "/" + CONFIG.repoName
              + "/contents/" + path.split("/").map(encodeURIComponent).join("/")
              + "?ref=" + encodeURIComponent(CONFIG.branch);
    const resp = await fetch(url, { headers: authHeaders() });
    if (resp.status === 404) return null;
    if (!resp.ok) throw new Error("加载标注失败: HTTP " + resp.status);
    const fileObj = await resp.json();
    const sha = fileObj.sha;
    let data = [];
    try {
      const text = base64ToUtf8(fileObj.content);
      data = JSON.parse(text);
    } catch (e) {
      console.warn("解析已有标注文件失败:", e);
    }
    return { sha, data };
  }

  /**
   * 保存标注结果到仓库
   * 使用 sha 做乐观并发控制
   * 返回 { ok, fileSha } 或 throw Error
   */
  async function saveMyAnnotations(annotationData, knownSha) {
    const user = window.GithubAuth.getUser();
    if (!user) throw new Error("未登录");
    const path = annotationPath(user.login);
    const url = API_BASE + "/repos/" + CONFIG.repoOwner + "/" + CONFIG.repoName
              + "/contents/" + path.split("/").map(encodeURIComponent).join("/");
    const content = utf8ToBase64(JSON.stringify(annotationData, null, 2));
    const body = {
      message: "标注更新 by " + user.login + " @ " + new Date().toISOString(),
      content: content,
      branch: CONFIG.branch,
    };
    // 更新已有文件需要 sha；创建新文件不需要
    let currentSha = knownSha;
    if (currentSha === undefined || currentSha === null) {
      // 先尝试获取当前 sha
      try {
        const existing = await loadMyAnnotations();
        currentSha = existing ? existing.sha : null;
      } catch (e) {
        currentSha = null;
      }
    }
    if (currentSha) body.sha = currentSha;

    const resp = await fetch(url, {
      method: "PUT",
      headers: authHeaders(),
      body: JSON.stringify(body),
    });

    if (resp.status === 409) {
      throw new Error("conflict");
    }
    if (resp.status === 401) {
      window.GithubAuth.logout();
      throw new Error("登录已过期，请重新登录");
    }
    if (resp.status === 403) {
      let msg = "权限不足";
      try {
        const errBody = await resp.json();
        if (errBody.message) msg = errBody.message;
      } catch (e) {}
      throw new Error(msg);
    }
    if (!resp.ok) {
      let errMsg = "HTTP " + resp.status;
      try {
        const errBody = await resp.json();
        if (errBody.message) errMsg += ": " + errBody.message;
      } catch (e) {}
      throw new Error("保存失败: " + errMsg);
    }
    const result = await resp.json();
    return {
      ok: true,
      commitSha: result.commit ? result.commit.sha : null,
      fileSha: result.content ? result.content.sha : null,
    };
  }

  /**
   * 列出 annotations/ 目录下所有标注文件
   * 返回 [{ name, sha, username }] 或空数组
   */
  async function listAllAnnotations() {
    const dirPath = CONFIG.annotationsPath.split("/").slice(0, -1).join("/") || "annotations";
    const url = API_BASE + "/repos/" + CONFIG.repoOwner + "/" + CONFIG.repoName
              + "/contents/" + dirPath.split("/").map(encodeURIComponent).join("/")
              + "?ref=" + encodeURIComponent(CONFIG.branch);
    const resp = await fetch(url, { headers: authHeaders() });
    if (resp.status === 404) return [];
    if (!resp.ok) throw new Error("获取标注列表失败: HTTP " + resp.status);
    const files = await resp.json();
    if (!Array.isArray(files)) return [];
    return files.map((f) => {
      const m = f.name.match(/^(.+)\.json$/);
      return { name: f.name, sha: f.sha, username: m ? m[1] : f.name };
    });
  }

  // ===== 暴露 API =====
  window.GithubStorage = {
    loadMyAnnotations: loadMyAnnotations,
    saveMyAnnotations: saveMyAnnotations,
    listAllAnnotations: listAllAnnotations,
    annotationPath: annotationPath,
  };
})();
