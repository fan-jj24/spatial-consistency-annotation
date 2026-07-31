/**
 * GitHub 分发 / 锁 / 单行保存模块
 *
 * 机制：
 * - 一行一个标注文件：annotations/line_XXXXXX__{username}.json
 * - 锁文件：locks/line_XXXXXX.json，内容 {username, ts}
 *   利用 GitHub "创建已存在文件会 409" 的特性实现抢锁
 * - 锁超过 LOCK_TTL 视为过期，可被他人覆盖抢占
 * - 用 Git Trees API 一次性列出全部文件，算出 已标注/已锁定 的行
 */

(function () {
  "use strict";

  const CONFIG = window.ANNOTATE_CONFIG.github;
  const API_BASE = "https://api.github.com";
  const LOCK_TTL = (CONFIG.lockTTLMinutes || 30) * 60 * 1000;

  function authHeaders() {
    const token = window.GithubAuth.getToken();
    if (!token) throw new Error("未登录，请先登录 GitHub");
    return {
      "Accept": "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Authorization": "Bearer " + token,
    };
  }

  function pad6(n) { return String(n).padStart(6, "0"); }
  function lineFileName(line) { return "line_" + pad6(line); }
  function annotationFilePath(line, username) {
    return CONFIG.linesDir + "/" + lineFileName(line) + "__" + username + ".json";
  }
  function lockFilePath(line) {
    return CONFIG.locksDir + "/" + lineFileName(line) + ".json";
  }

  // ===== Base64 UTF-8 安全编解码 =====
  function utf8ToBase64(str) {
    const bytes = new TextEncoder().encode(str);
    let bin = "";
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }
  function base64ToUtf8(b64) {
    const bin = atob(b64.replace(/\n/g, ""));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }

  /**
   * 一次性列出仓库全部文件路径（递归）
   * 返回 [string]
   */
  async function listAllFiles() {
    const url = API_BASE + "/repos/" + CONFIG.repoOwner + "/" + CONFIG.repoName
              + "/git/trees/" + encodeURIComponent(CONFIG.branch) + "?recursive=1";
    const resp = await fetch(url, { headers: authHeaders() });
    if (!resp.ok) throw new Error("列出仓库文件失败: HTTP " + resp.status);
    const data = await resp.json();
    return (data.tree || []).filter((t) => t.type === "blob").map((t) => t.path);
  }

  /**
   * 从文件列表解析出 已标注行集合 和 锁映射
   * @returns {{done:Set<number>, locks:Map<number,{username:string,ts:number}>, lockSha:Map<number,string>}}
   */
  async function scanStatus() {
    const files = await listAllFiles();
    const done = new Set();
    const locks = new Map();
    const lockSha = new Map();
    const annoPrefix = CONFIG.linesDir + "/";
    const lockPrefix = CONFIG.locksDir + "/";
    for (const path of files) {
      if (path.startsWith(annoPrefix) && path.endsWith(".json")) {
        const m = path.slice(annoPrefix.length).match(/^line_(\d+)__/);
        if (m) done.add(parseInt(m[1], 10));
      }
    }
    // 锁文件需要读内容（含 username/ts）和 sha
    const lockPaths = files.filter((p) => p.startsWith(lockPrefix) && p.endsWith(".json"));
    for (const path of lockPaths) {
      const m = path.slice(lockPrefix.length).match(/^line_(\d+)\.json$/);
      if (!m) continue;
      const line = parseInt(m[1], 10);
      try {
        const info = await getFileRaw(path);
        if (info) {
          locks.set(line, info.data);
          lockSha.set(line, info.sha);
        }
      } catch (e) { /* 忽略单个锁读取失败 */ }
    }
    return { done, locks, lockSha };
  }

  /**
   * 读取文件原始内容（base64 解码后 JSON 解析）
   * 返回 { sha, data } 或 null
   */
  async function getFileRaw(path) {
    const url = API_BASE + "/repos/" + CONFIG.repoOwner + "/" + CONFIG.repoName
              + "/contents/" + path.split("/").map(encodeURIComponent).join("/")
              + "?ref=" + encodeURIComponent(CONFIG.branch);
    const resp = await fetch(url, { headers: authHeaders() });
    if (resp.status === 404) return null;
    if (!resp.ok) throw new Error("读取文件失败: HTTP " + resp.status);
    const obj = await resp.json();
    let data = null;
    try { data = JSON.parse(base64ToUtf8(obj.content)); } catch (e) {}
    return { sha: obj.sha, data };
  }

  /**
   * 写文件（创建或更新）。knownSha=null 表示创建。
   * 返回 { ok, fileSha } 或 throw（409 冲突时 throw Error("conflict")）
   */
  async function putFile(path, jsonData, knownSha, message) {
    const url = API_BASE + "/repos/" + CONFIG.repoOwner + "/" + CONFIG.repoName
              + "/contents/" + path.split("/").map(encodeURIComponent).join("/");
    const body = {
      message: message,
      content: utf8ToBase64(JSON.stringify(jsonData, null, 2)),
      branch: CONFIG.branch,
    };
    if (knownSha) body.sha = knownSha;
    const resp = await fetch(url, {
      method: "PUT",
      headers: authHeaders(),
      body: JSON.stringify(body),
    });
    if (resp.status === 409) throw new Error("conflict");
    if (resp.status === 401) { window.GithubAuth.logout(); throw new Error("登录已过期，请重新登录"); }
    if (resp.status === 403) throw new Error("权限不足，请确认 PAT 有 Contents 写权限");
    if (!resp.ok) {
      let msg = "HTTP " + resp.status;
      try { const b = await resp.json(); if (b.message) msg += ": " + b.message; } catch (e) {}
      throw new Error("写入失败: " + msg);
    }
    const result = await resp.json();
    return { ok: true, fileSha: result.content ? result.content.sha : null };
  }

  /**
   * 删除文件
   */
  async function deleteFile(path, sha, message) {
    const url = API_BASE + "/repos/" + CONFIG.repoOwner + "/" + CONFIG.repoName
              + "/contents/" + path.split("/").map(encodeURIComponent).join("/");
    const resp = await fetch(url, {
      method: "DELETE",
      headers: authHeaders(),
      body: JSON.stringify({ message: message, sha: sha, branch: CONFIG.branch }),
    });
    if (resp.status === 404) return { ok: true }; // 已不存在
    if (!resp.ok) {
      let msg = "HTTP " + resp.status;
      try { const b = await resp.json(); if (b.message) msg += ": " + b.message; } catch (e) {}
      throw new Error("删除失败: " + msg);
    }
    return { ok: true };
  }

  function isLockStale(lock) {
    if (!lock || !lock.ts) return true;
    return (Date.now() - lock.ts) > LOCK_TTL;
  }

  /**
   * 抢锁。成功返回 {ok:true, sha}；被他人占用返回 {ok:false, by}
   */
  async function acquireLock(line, username) {
    const path = lockFilePath(line);
    let existing = null;
    try { existing = await getFileRaw(path); } catch (e) {}
    if (existing && existing.data) {
      const mine = existing.data.username === username;
      const stale = isLockStale(existing.data);
      if (!mine && !stale) {
        return { ok: false, by: existing.data.username };
      }
      // 自己的锁 或 过期锁 → 覆盖更新
      const res = await putFile(path, { username: username, ts: Date.now() }, existing.sha,
        "锁定 line " + line + " by " + username);
      return { ok: true, sha: res.fileSha };
    }
    // 无锁 → 创建（可能被别人抢先 → 409）
    try {
      const res = await putFile(path, { username: username, ts: Date.now() }, null,
        "锁定 line " + line + " by " + username);
      return { ok: true, sha: res.fileSha };
    } catch (e) {
      if (e.message === "conflict") return { ok: false, by: "其他用户" };
      throw e;
    }
  }

  /**
   * 释放锁（删除锁文件）
   */
  async function releaseLock(line, lockSha) {
    if (!lockSha) {
      // 没有 sha 就现查
      try {
        const info = await getFileRaw(lockFilePath(line));
        if (info) lockSha = info.sha;
      } catch (e) {}
    }
    if (!lockSha) return { ok: true };
    try {
      return await deleteFile(lockFilePath(line), lockSha, "释放 line " + line);
    } catch (e) {
      console.warn("释放锁失败:", e);
      return { ok: false };
    }
  }

  /**
   * 保存一行标注
   */
  async function saveLine(line, username, data) {
    const path = annotationFilePath(line, username);
    let sha = null;
    try { const info = await getFileRaw(path); if (info) sha = info.sha; } catch (e) {}
    const res = await putFile(path, data, sha,
      "标注 line " + line + " by " + username + " @ " + new Date().toISOString());
    return res;
  }

  /**
   * 加载一行标注（可能是自己之前标的，用于恢复）
   * 返回 data 或 null
   */
  async function loadLine(line, username) {
    try {
      const info = await getFileRaw(annotationFilePath(line, username));
      return info ? info.data : null;
    } catch (e) { return null; }
  }

  /**
   * 高层封装：领取下一个空闲样本并加锁
   * @param {Array<{line:number}>} samples - samples.json 全部样本
   * @returns {Promise<{sample:object, line:number, resumed?:boolean}|null>}
   */
  async function claimNext(samples) {
    const username = (window.GithubAuth.getUser() || {}).login;
    if (!username) throw new Error("未登录");
    const allLines = samples.map((s) => s.line);
    const byLine = {};
    samples.forEach((s) => { byLine[s.line] = s; });

    // 最多尝试 N 次（应对并发抢锁失败）
    const MAX_TRY = 8;
    let tried = new Set();
    for (let i = 0; i < MAX_TRY; i++) {
      const free = await findNextFreeLine(allLines.filter((l) => !tried.has(l)), username);
      if (!free) return null;
      const line = free.line;
      const lockRes = await acquireLock(line, username);
      if (lockRes.ok) {
        return { sample: byLine[line], line: line, resumed: !!free.resumed };
      }
      // 抢锁失败（被别人抢先）→ 标记已试，换下一行
      tried.add(line);
    }
    return null;
  }

  /**
   * 高层封装：统计进度
   * @returns {Promise<{done:number, locked:number, total:number}>}
   */
  async function getStats(samples) {
    const allLines = samples.map((s) => s.line);
    const status = await scanStatus();
    let done = 0, locked = 0;
    for (const line of allLines) {
      if (status.done.has(line)) { done++; continue; }
      const lock = status.locks.get(line);
      if (lock && !isLockStale(lock)) locked++;
    }
    return { done: done, locked: locked, total: allLines.length };
  }

  /**
   * 找到第一个空闲行（未标注且未被有效锁定）
   * @param {number[]} allLines - samples.json 里的全部行号
   * @returns {Promise<{line:number}|{line:number, resumed:true}|null>}
   */
  async function findNextFreeLine(allLines, username) {
    const status = await scanStatus();
    // 1) 先看自己有没有遗留的锁（断点续标）
    for (const [line, lock] of status.locks.entries()) {
      if (lock.username === username && allLines.includes(line)) {
        return { line: line, resumed: true };
      }
    }
    // 2) 找第一个 未标注 且 未被有效锁定 的行
    for (const line of allLines) {
      if (status.done.has(line)) continue;
      const lock = status.locks.get(line);
      if (lock && !isLockStale(lock) && lock.username !== username) continue;
      return { line: line };
    }
    return null; // 全部标完
  }

  // ===== 暴露 API =====
  window.GithubDispatch = {
    listAllFiles: listAllFiles,
    scanStatus: scanStatus,
    findNextFreeLine: findNextFreeLine,
    claimNext: claimNext,
    getStats: getStats,
    acquireLock: acquireLock,
    releaseLock: releaseLock,
    saveLine: saveLine,
    loadLine: loadLine,
    annotationFilePath: annotationFilePath,
    lockFilePath: lockFilePath,
    isLockStale: isLockStale,
  };
})();
