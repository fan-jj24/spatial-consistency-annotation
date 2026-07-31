/**
 * GitHub PAT 认证模块
 * 纯前端实现，使用 Personal Access Token 认证
 *
 * 为什么不用 OAuth Device Flow？
 * GitHub 的 /login/device/code 端点不支持 CORS，浏览器端 fetch 会被拦截。
 * PAT 是唯一可行的纯静态站点 GitHub 认证方案。
 *
 * PAT 权限要求：
 * - Fine-grained PAT：Contents (Read and Write)
 * - Classic PAT：repo scope
 */

(function () {
  "use strict";

  const TOKEN_KEY = "annotate_github_pat";
  const USER_KEY = "annotate_github_user";
  const ANNOTATOR_KEY = "annotate_annotator_name";

  // ===== Token 存取（localStorage）=====
  function getToken() {
    try { return localStorage.getItem(TOKEN_KEY) || null; } catch (e) { return null; }
  }
  function setToken(token) {
    try { localStorage.setItem(TOKEN_KEY, token); } catch (e) {}
  }
  function getUser() {
    try { return JSON.parse(localStorage.getItem(USER_KEY) || "null"); } catch (e) { return null; }
  }
  function setUser(user) {
    try { localStorage.setItem(USER_KEY, JSON.stringify(user)); } catch (e) {}
  }

  // ===== 标注员名字（手动输入，作为标注记录标识）=====
  function getAnnotatorName() {
    try { return localStorage.getItem(ANNOTATOR_KEY) || ""; } catch (e) { return ""; }
  }
  function setAnnotatorName(name) {
    try { localStorage.setItem(ANNOTATOR_KEY, name); } catch (e) {}
  }
  // 文件名安全处理：保留中文/字母/数字/_/-，其余替换为 _
  function sanitizeId(name) {
    const s = (name || "").trim()
      .replace(/[\\/:*?"<>|\s]+/g, "_")
      .replace(/_+/g, "_")
      .replace(/^_+|_+$/g, "");
    return s || "anonymous";
  }
  // 标注记录标识：优先用手动输入的名字，否则回退到 GitHub login
  function getAnnotatorId() {
    const name = getAnnotatorName();
    if (name) return sanitizeId(name);
    const user = getUser();
    return user ? user.login : "anonymous";
  }

  function clearAuth() {
    try {
      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(USER_KEY);
      localStorage.removeItem(ANNOTATOR_KEY);
    } catch (e) {}
  }

  /**
   * 用 PAT 获取 GitHub 用户信息并验证 token 有效性
   * @param {string} token - PAT
   * @returns {Promise<{login, name, avatarUrl, id}>}
   */
  async function fetchUser(token) {
    const resp = await fetch("https://api.github.com/user", {
      headers: {
        "Authorization": "Bearer " + token,
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    if (resp.status === 401) {
      throw new Error("Token 无效或已过期");
    }
    if (resp.status === 403) {
      throw new Error("Token 权限不足或触发限流");
    }
    if (!resp.ok) {
      throw new Error("验证失败: HTTP " + resp.status);
    }
    const user = await resp.json();
    return {
      login: user.login,
      name: user.name || user.login,
      avatarUrl: user.avatar_url,
      id: user.id,
    };
  }

  /**
   * 用 PAT 登录（验证 token + 获取用户信息）
   * @param {string} token - PAT
   * @returns {Promise<{token, user}>}
   */
  async function login(token) {
    token = token.trim();
    if (!token) throw new Error("请输入 Token");
    const user = await fetchUser(token);
    setToken(token);
    setUser(user);
    return { token: token, user: user };
  }

  /**
   * 检查已保存的 token 是否仍然有效
   */
  async function checkToken() {
    const token = getToken();
    if (!token) return null;
    try {
      const user = await fetchUser(token);
      setUser(user);
      return { token, user };
    } catch (e) {
      clearAuth();
      return null;
    }
  }

  function logout() {
    clearAuth();
  }

  // ===== 暴露 API =====
  window.GithubAuth = {
    login: login,
    checkToken: checkToken,
    getToken: getToken,
    getUser: getUser,
    logout: logout,
    getAnnotatorName: getAnnotatorName,
    setAnnotatorName: setAnnotatorName,
    getAnnotatorId: getAnnotatorId,
  };
})();
