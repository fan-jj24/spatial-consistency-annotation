/**
 * GitHub 批量分发 / 锁 / 上传模块（v2）
 *
 * 核心变化：从"每行一个锁文件"改为"每人一个批量锁文件"
 * - 锁文件：locks/{datasetId}/batch__{username}.json → {lines:[...], ts}
 * - 标注结果：annotations/{datasetId}/line_XXXXXX__{username}.json（不变）
 * - 审核结果：reviews/{datasetId}/line_XXXXXX__{reviewerName}.json（不变）
 * - 审核锁：locks-review/{datasetId}/batch__{reviewerName}.json
 *
 * 流程：
 * 1. claimBatch(count) → 扫描仓库 → 随机选 N 条空闲行 → 写入批量锁 → 返回样本
 * 2. 本地标注（零 API 调用，存 localStorage）
 * 3. uploadBatch(results) → 逐条保存标注/审核 → 更新批量锁（移除已完成的行）
 * 4. releaseBatch() → 删除批量锁（全部释放回池子）
 */

(function () {
  "use strict";

  const CONFIG = window.ANNOTATE_CONFIG.github;
  const API_BASE = "https://api.github.com";
  const LOCK_TTL = (CONFIG.lockTTLMinutes || 30) * 60 * 1000;

  // 当前数据集 id
  let currentDatasetId = "default";
  function setDataset(id) { currentDatasetId = id || "default"; }
  function getDataset() { return currentDatasetId; }

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

  // ===== 路径函数 =====
  function annotationFilePath(line, username) {
    return CONFIG.linesDir + "/" + currentDatasetId + "/" + lineFileName(line) + "__" + username + ".json";
  }
  function reviewFilePath(line, reviewerName) {
    return CONFIG.reviewsDir + "/" + currentDatasetId + "/" + lineFileName(line) + "__" + reviewerName + ".json";
  }
  // 批量锁文件（每人每数据集一个）
  function batchLockPath(username) {
    return CONFIG.locksDir + "/" + currentDatasetId + "/batch__" + username + ".json";
  }
  function reviewBatchLockPath(reviewerName) {
    return CONFIG.reviewLocksDir + "/" + currentDatasetId + "/batch__" + reviewerName + ".json";
  }
  // 目录前缀（用于扫描）
  function annoPrefix() { return CONFIG.linesDir + "/" + currentDatasetId + "/"; }
  function reviewPrefix() { return CONFIG.reviewsDir + "/" + currentDatasetId + "/"; }
  function lockPrefix() { return CONFIG.locksDir + "/" + currentDatasetId + "/"; }
  function reviewLockPrefix() { return CONFIG.reviewLocksDir + "/" + currentDatasetId + "/"; }

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

  // ===== GitHub API 基础操作 =====

  async function listAllFiles() {
    const url = API_BASE + "/repos/" + CONFIG.repoOwner + "/" + CONFIG.repoName
              + "/git/trees/" + encodeURIComponent(CONFIG.branch) + "?recursive=1";
    const resp = await fetch(url, { headers: authHeaders() });
    if (!resp.ok) throw new Error("列出仓库文件失败: HTTP " + resp.status);
    const data = await resp.json();
    return (data.tree || []).filter((t) => t.type === "blob").map((t) => t.path);
  }

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
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.message || "写入失败: HTTP " + resp.status);
    }
    const result = await resp.json();
    return { ok: true, fileSha: result.content.sha };
  }

  async function deleteFile(path, sha, message) {
    const url = API_BASE + "/repos/" + CONFIG.repoOwner + "/" + CONFIG.repoName
              + "/contents/" + path.split("/").map(encodeURIComponent).join("/");
    const resp = await fetch(url, {
      method: "DELETE",
      headers: authHeaders(),
      body: JSON.stringify({ message: message, sha: sha, branch: CONFIG.branch }),
    });
    if (resp.status === 404) return { ok: true };
    if (!resp.ok) throw new Error("删除失败: HTTP " + resp.status);
    return { ok: true };
  }

  // ===== 锁过期判断 =====
  function isLockStale(lockData) {
    if (!lockData || !lockData.ts) return true;
    return (Date.now() - lockData.ts) > LOCK_TTL;
  }

  // ===== 扫描仓库状态 =====
  /**
   * 一次扫描获取全部状态
   * @returns {{done:Set, reviewed:Set, lockedLines:Set, reviewLockedLines:Set, myLock:{lines,sha}|null, myReviewLock:{lines,sha}|null}}
   */
  async function scanStatus() {
    const files = await listAllFiles();
    const done = new Set();
    const reviewed = new Set();
    const lockedLines = new Set();       // 所有被锁定的标注行
    const reviewLockedLines = new Set(); // 所有被锁定的审核行
    let myLock = null;
    let myReviewLock = null;

    const username = window.GithubAuth.getAnnotatorId();
    const aPfx = annoPrefix();
    const rPfx = reviewPrefix();
    const lPfx = lockPrefix();
    const rlPfx = reviewLockPrefix();

    // 解析已标注/已审核
    for (const path of files) {
      if (path.startsWith(aPfx) && path.endsWith(".json")) {
        const m = path.slice(aPfx.length).match(/^line_(\d+)__/);
        if (m) done.add(parseInt(m[1], 10));
      }
      if (path.startsWith(rPfx) && path.endsWith(".json")) {
        const m = path.slice(rPfx.length).match(/^line_(\d+)__/);
        if (m) reviewed.add(parseInt(m[1], 10));
      }
    }

    // 解析批量锁文件
    const lockPaths = files.filter((p) => p.startsWith(lPfx) && p.endsWith(".json"));
    for (const path of lockPaths) {
      const m = path.slice(lPfx.length).match(/^batch__(.+)\.json$/);
      if (!m) continue;
      try {
        const info = await getFileRaw(path);
        if (!info || !info.data) continue;
        const lockData = info.data;
        if (isLockStale(lockData)) continue; // 过期锁忽略
        const lines = lockData.lines || [];
        if (m[1] === username) {
          myLock = { lines: lines, sha: info.sha, path: path };
        }
        lines.forEach((l) => lockedLines.add(l));
      } catch (e) {}
    }

    // 解析审核批量锁文件
    const reviewLockPaths = files.filter((p) => p.startsWith(rlPfx) && p.endsWith(".json"));
    for (const path of reviewLockPaths) {
      const m = path.slice(rlPfx.length).match(/^batch__(.+)\.json$/);
      if (!m) continue;
      try {
        const info = await getFileRaw(path);
        if (!info || !info.data) continue;
        const lockData = info.data;
        if (isLockStale(lockData)) continue;
        const lines = lockData.lines || [];
        if (m[1] === username) {
          myReviewLock = { lines: lines, sha: info.sha, path: path };
        }
        lines.forEach((l) => reviewLockedLines.add(l));
      } catch (e) {}
    }

    return { done, reviewed, lockedLines, reviewLockedLines, myLock, myReviewLock };
  }

  // ===== 池子统计 =====
  /**
   * 获取当前数据集的池子统计
   * @param {Array<{line:number}>} samples
   * @param {boolean} isReview - true=审核池, false=标注池
   * @returns {Promise<{total, done, locked, available}>}
   */
  async function getPoolStats(samples, isReview) {
    const allLines = samples.map((s) => s.line);
    const status = await scanStatus();
    let done = 0, locked = 0;
    for (const line of allLines) {
      if (isReview) {
        if (status.reviewed.has(line)) { done++; continue; }
        if (!status.done.has(line)) continue; // 未标注的不算审核池
        if (status.reviewLockedLines.has(line)) locked++;
      } else {
        if (status.done.has(line)) { done++; continue; }
        if (status.lockedLines.has(line)) locked++;
      }
    }
    const total = isReview
      ? allLines.filter((l) => status.done.has(l)).length  // 审核池 = 已标注的
      : allLines.length;
    const available = total - done - locked;
    return { total, done, locked, available };
  }

  // ===== 批量领取 =====
  /**
   * 批量领取 N 条空闲样本并加锁
   * @param {Array<{line,remotes,locals}>} samples - 全部样本
   * @param {number} count - 要领取的数量
   * @param {boolean} isReview - true=审核模式
   * @returns {Promise<{samples: Array, lines: number[]}>}
   */
  async function claimBatch(samples, count, isReview) {
    const username = window.GithubAuth.getAnnotatorId();
    if (!username) throw new Error("未登录");

    const status = await scanStatus();
    const byLine = {};
    samples.forEach((s) => { byLine[s.line] = s; });

    // 收集候选行
    const candidates = [];
    for (const s of samples) {
      const line = s.line;
      if (isReview) {
        if (!status.done.has(line)) continue;       // 必须已标注
        if (status.reviewed.has(line)) continue;     // 已审核
        if (status.reviewLockedLines.has(line)) continue; // 被锁
      } else {
        if (status.done.has(line)) continue;         // 已标注
        if (status.lockedLines.has(line)) continue;  // 被锁
      }
      candidates.push(line);
    }

    // 随机打乱，取前 count 条
    for (let i = candidates.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
    }
    const picked = candidates.slice(0, Math.min(count, candidates.length));
    if (!picked.length) throw new Error("没有可用的数据了");

    // 写入批量锁
    const lockPath = isReview ? reviewBatchLockPath(username) : batchLockPath(username);
    let existingLock = null;
    try { existingLock = await getFileRaw(lockPath); } catch (e) {}

    // 合并已有锁的行（断点续标场景）
    const existingLines = (existingLock && existingLock.data && existingLock.data.lines) || [];
    const allLockedLines = [...new Set([...existingLines, ...picked])];

    await putFile(lockPath, { username, lines: allLockedLines, ts: Date.now() },
      existingLock ? existingLock.sha : null,
      (isReview ? "审核" : "标注") + "批量锁定 " + allLockedLines.length + " 行 by " + username);

    return {
      samples: picked.map((l) => byLine[l]),
      lines: picked,
    };
  }

  // ===== 批量上传 =====
  /**
   * 上传已完成的标注/审核结果，并更新批量锁
   * @param {Array<{line, data}>} results - 已完成的结果 [{line, data}]
   * @param {boolean} isReview
   * @returns {Promise<{saved:number, released:number}>}
   */
  async function uploadBatch(results, isReview) {
    const username = window.GithubAuth.getAnnotatorId();
    if (!username) throw new Error("未登录");

    let saved = 0;
    for (const item of results) {
      const path = isReview
        ? reviewFilePath(item.line, username)
        : annotationFilePath(item.line, username);
      // 检查是否已存在（更新）
      let sha = null;
      try { const info = await getFileRaw(path); if (info) sha = info.sha; } catch (e) {}
      await putFile(path, item.data, sha,
        (isReview ? "审核" : "标注") + " line " + item.line + " by " + username);
      saved++;
    }

    // 更新批量锁：移除已完成的行
    const doneLines = new Set(results.map((r) => r.line));
    const lockPath = isReview ? reviewBatchLockPath(username) : batchLockPath(username);
    let lockInfo = null;
    try { lockInfo = await getFileRaw(lockPath); } catch (e) {}
    if (lockInfo && lockInfo.data) {
      const remaining = (lockInfo.data.lines || []).filter((l) => !doneLines.has(l));
      if (remaining.length > 0) {
        await putFile(lockPath, { username, lines: remaining, ts: Date.now() },
          lockInfo.sha, "更新批量锁: 剩余 " + remaining.length + " 行");
      } else {
        // 全部完成，删除锁文件
        await deleteFile(lockPath, lockInfo.sha, "批量任务完成 by " + username);
      }
    }

    return { saved, released: results.length };
  }

  // ===== 释放批量锁（全部释放回池子）=====
  /**
   * 释放指定行（未完成的行回到池子）
   * @param {number[]} linesToRelease - 要释放的行号
   * @param {boolean} isReview
   */
  async function releaseBatchLines(linesToRelease, isReview) {
    const username = window.GithubAuth.getAnnotatorId();
    if (!username || !linesToRelease.length) return;
    const lockPath = isReview ? reviewBatchLockPath(username) : batchLockPath(username);
    let lockInfo = null;
    try { lockInfo = await getFileRaw(lockPath); } catch (e) {}
    if (!lockInfo || !lockInfo.data) return;
    const releaseSet = new Set(linesToRelease);
    const remaining = (lockInfo.data.lines || []).filter((l) => !releaseSet.has(l));
    if (remaining.length > 0) {
      await putFile(lockPath, { username, lines: remaining, ts: Date.now() },
        lockInfo.sha, "释放 " + linesToRelease.length + " 行回池子");
    } else {
      await deleteFile(lockPath, lockInfo.sha, "释放全部锁 by " + username);
    }
  }

  // ===== 释放全部锁 =====
  async function releaseAll(isReview) {
    const username = window.GithubAuth.getAnnotatorId();
    if (!username) return;
    const lockPath = isReview ? reviewBatchLockPath(username) : batchLockPath(username);
    let lockInfo = null;
    try { lockInfo = await getFileRaw(lockPath); } catch (e) {}
    if (lockInfo && lockInfo.sha) {
      await deleteFile(lockPath, lockInfo.sha, "释放全部锁 by " + username);
    }
  }

  // ===== 加载一行的已有标注（审核者查看用）=====
  async function loadAnnotationForReview(line) {
    const files = await listAllFiles();
    const pfx = annoPrefix();
    for (const path of files) {
      if (path.startsWith(pfx) && path.endsWith(".json")) {
        const m = path.slice(pfx.length).match(/^line_(\d+)__(.+)\.json$/);
        if (m && parseInt(m[1], 10) === line) {
          try {
            const info = await getFileRaw(path);
            if (info && info.data) return { data: info.data, annotatorName: m[2] };
          } catch (e) {}
        }
      }
    }
    return null;
  }

  // ===== 暴露 API =====
  window.GithubDispatch = {
    setDataset: setDataset,
    getDataset: getDataset,
    listAllFiles: listAllFiles,
    scanStatus: scanStatus,
    getPoolStats: getPoolStats,
    claimBatch: claimBatch,
    uploadBatch: uploadBatch,
    releaseBatchLines: releaseBatchLines,
    releaseAll: releaseAll,
    loadAnnotationForReview: loadAnnotationForReview,
    getFileRaw: getFileRaw,
    annotationFilePath: annotationFilePath,
    reviewFilePath: reviewFilePath,
    isLockStale: isLockStale,
  };
})();
