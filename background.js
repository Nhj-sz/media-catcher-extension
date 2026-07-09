// 引入 B 站取流客户端（WBI 签名 + playurl 解析），暴露为 globalThis.MCD_BILI
try {
  importScripts("./bilibili_api.js");
} catch (e) {
  // 忽略：非 B 站场景下不会用到
}

const TAB_DATA = new Map();
const MAX_ITEMS_PER_TAB = 300;

// ---- 持久化到 chrome.storage.session（解决 MV3 Service Worker 回收后数据丢失）----
const STORAGE_KEY = "MCD_TAB_DATA_V1";
const PERSIST_DEBOUNCE_MS = 1500;
let persistTimer = null;

function serializeBucket(bucket) {
  return {
    network: [...bucket.network.entries()],
    dom: [...bucket.dom.entries()],
    pageTitle: bucket.pageTitle || "",
    pageUrl: bucket.pageUrl || "",
    updatedAt: bucket.updatedAt || Date.now()
  };
}

function deserializeBucket(obj) {
  const bucket = {
    network: new Map(),
    dom: new Map(),
    pageTitle: "",
    pageUrl: "",
    updatedAt: Date.now()
  };

  try {
    if (Array.isArray(obj.network)) {
      for (const [k, v] of obj.network) {
        bucket.network.set(k, v);
      }
    }

    if (Array.isArray(obj.dom)) {
      for (const [k, v] of obj.dom) {
        bucket.dom.set(k, v);
      }
    }

    bucket.pageTitle = obj.pageTitle || "";
    bucket.pageUrl = obj.pageUrl || "";
    bucket.updatedAt = obj.updatedAt || Date.now();
  } catch {
    // ignore partial deserialize errors
  }

  return bucket;
}

function schedulePersist() {
  if (persistTimer) {
    return;
  }

  persistTimer = setTimeout(() => {
    persistTimer = null;
    persistNow();
  }, PERSIST_DEBOUNCE_MS);
}

async function persistNow() {
  if (typeof chrome === "undefined" || !chrome.storage || !chrome.storage.session) {
    return;
  }

  try {
    const obj = {};
    for (const [tabId, bucket] of TAB_DATA.entries()) {
      obj[String(tabId)] = serializeBucket(bucket);
    }

    await chrome.storage.session.set({ [STORAGE_KEY]: obj });
  } catch {
    // ignore storage errors
  }
}

async function loadPersisted() {
  if (typeof chrome === "undefined" || !chrome.storage || !chrome.storage.session) {
    return;
  }

  try {
    const result = await chrome.storage.session.get([STORAGE_KEY]);
    const obj = result && result[STORAGE_KEY];
    if (!obj || typeof obj !== "object") {
      return;
    }

    for (const [tabIdStr, bucketObj] of Object.entries(obj)) {
      const tabId = Number(tabIdStr);
      if (!Number.isFinite(tabId) || tabId < 0) {
        continue;
      }

      const incoming = deserializeBucket(bucketObj);
      const existing = TAB_DATA.get(tabId);

      if (!existing) {
        TAB_DATA.set(tabId, incoming);
        continue;
      }

      for (const [k, v] of incoming.network.entries()) {
        if (!existing.network.has(k)) {
          existing.network.set(k, v);
        }
      }

      for (const [k, v] of incoming.dom.entries()) {
        if (!existing.dom.has(k)) {
          existing.dom.set(k, v);
        }
      }

      TAB_DATA.set(tabId, existing);
    }
  } catch {
    // ignore storage load errors
  }
}
const MEDIA_EXTENSIONS = [
  ".mp4",
  ".webm",
  ".m3u8",
  ".mpd",
  ".mov",
  ".m4v",
  ".flv",
  ".avi",
  ".mkv",
  ".ts",
  ".mp3",
  ".m4a",
  ".aac",
  ".ogg",
  ".wav"
];

function getTabBucket(tabId) {
  if (!TAB_DATA.has(tabId)) {
    TAB_DATA.set(tabId, {
      network: new Map(),
      dom: new Map(),
      pageTitle: "",
      pageUrl: "",
      updatedAt: Date.now()
    });
  }

  return TAB_DATA.get(tabId);
}

function normalizeUrl(url) {
  if (!url) {
    return "";
  }

  if (url.startsWith("blob:") || url.startsWith("data:")) {
    return url;
  }

  try {
    const u = new URL(url);
    u.hash = "";
    return u.href;
  } catch {
    return url;
  }
}

function getHeader(headers, headerName) {
  if (!Array.isArray(headers)) {
    return "";
  }

  const found = headers.find((h) =>
    (h.name || "").toLowerCase() === headerName.toLowerCase()
  );

  return found ? found.value || "" : "";
}

function toInt(value) {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : 0;
  }

  if (typeof value !== "string") {
    return 0;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function toNumber(value) {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : 0;
  }

  if (typeof value !== "string") {
    return 0;
  }

  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isLikelyMediaUrl(url, mimeType = "") {
  const lowerMime = mimeType.toLowerCase();
  if (lowerMime.startsWith("video/") || lowerMime.startsWith("audio/")) {
    return true;
  }

  if (lowerMime.includes("mpegurl") || lowerMime.includes("dash+xml")) {
    return true;
  }

  const lowerUrl = (url || "").toLowerCase();
  if (lowerUrl.startsWith("blob:")) {
    return true;
  }

  if (MEDIA_EXTENSIONS.some((ext) => lowerUrl.includes(ext))) {
    return true;
  }

  return /[?&](mime|type|format)=([^&#]*(video|audio))/i.test(lowerUrl);
}

function safeText(text, maxLength = 120) {
  if (typeof text !== "string") {
    return "";
  }

  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length > maxLength ? `${compact.slice(0, maxLength)}...` : compact;
}

function isMediaSegmentUrl(url) {
  if (!url || typeof url !== "string") {
    return false;
  }

  const u = url.toLowerCase();
  if (/\.m4s([?#]|$)/i.test(u)) {
    return true;
  }
  if (/[?&](range|bytestart|biteend|fragment|segment|mssegment|sq)=/i.test(u)) {
    return true;
  }
  if (/(\/sq\/|\/init(\.|$)|init\.mp4|\/chunk|\/segment|\/fragment|seg[-_]\d+|bytestart|biteend)/i.test(u)) {
    return true;
  }
  return false;
}

function guessFilenameFromUrl(url) {
  if (!url) {
    return "media";
  }

  try {
    const parsed = new URL(url);
    const pathParts = parsed.pathname.split("/").filter(Boolean);
    const raw = pathParts.length ? pathParts[pathParts.length - 1] : "media";
    const clean = decodeURIComponent(raw).replace(/[\\/:*?"<>|]+/g, "_").trim();
    return clean || "media";
  } catch {
    return "media";
  }
}

function ensureCapacity(map) {
  if (map.size <= MAX_ITEMS_PER_TAB) {
    return;
  }

  const sorted = [...map.entries()].sort(
    (a, b) => (a[1].lastSeen || 0) - (b[1].lastSeen || 0)
  );

  while (map.size > MAX_ITEMS_PER_TAB && sorted.length) {
    const [oldestKey] = sorted.shift();
    map.delete(oldestKey);
  }
}

function mergeFields(target, source) {
  if (!target.label && source.label) {
    target.label = safeText(source.label, 140);
  }

  if (!target.pageTitle && source.pageTitle) {
    target.pageTitle = safeText(source.pageTitle, 140);
  }

  if (!target.pageUrl && source.pageUrl) {
    target.pageUrl = source.pageUrl;
  }

  if (!target.mimeType && source.mimeType) {
    target.mimeType = source.mimeType;
  }

  if (!target.filenameHint && source.filenameHint) {
    target.filenameHint = source.filenameHint;
  }

  if (!target.duration && source.duration) {
    target.duration = source.duration;
  }

  if (!target.width && source.width) {
    target.width = source.width;
  }

  if (!target.height && source.height) {
    target.height = source.height;
  }

  if (!target.contentLength && source.contentLength) {
    target.contentLength = source.contentLength;
  }

  if (!target.domId && source.domId) {
    target.domId = source.domId;
  }

  if (!target.rectX && source.rectX) {
    target.rectX = source.rectX;
  }

  if (!target.rectY && source.rectY) {
    target.rectY = source.rectY;
  }

  if (!target.rectWidth && source.rectWidth) {
    target.rectWidth = source.rectWidth;
  }

  if (!target.rectHeight && source.rectHeight) {
    target.rectHeight = source.rectHeight;
  }

  if (!target.domOrder && source.domOrder) {
    target.domOrder = source.domOrder;
  }

  if (!target.isVisible && source.isVisible) {
    target.isVisible = true;
  }

  if (!target.isPlaying && source.isPlaying) {
    target.isPlaying = true;
  }

  target.lastSeen = Math.max(target.lastSeen || 0, source.lastSeen || 0);
}

function addNetworkMedia(details) {
  const tabId = details.tabId;
  if (typeof tabId !== "number" || tabId < 0) {
    return;
  }

  const contentTypeFull = getHeader(details.responseHeaders, "content-type");
  const mimeType = contentTypeFull.split(";")[0].trim();

  if (details.type !== "media" && !isLikelyMediaUrl(details.url, mimeType)) {
    return;
  }

  const bucket = getTabBucket(tabId);
  const key = normalizeUrl(details.url);
  if (!key) {
    return;
  }

  const now = Date.now();
  const previous = bucket.network.get(key) || {};
  const next = {
    ...previous,
    url: key,
    lastSeen: now,
    firstSeen: previous.firstSeen || now,
    sourceNetwork: true,
    requestType: details.type || previous.requestType || "",
    mimeType: mimeType || previous.mimeType || "",
    statusCode: details.statusCode || previous.statusCode || 0,
    contentLength:
      toInt(getHeader(details.responseHeaders, "content-length")) || previous.contentLength || 0,
    method: details.method || previous.method || "GET",
    initiator: details.initiator || previous.initiator || "",
    filenameHint: previous.filenameHint || guessFilenameFromUrl(key)
  };

  bucket.network.set(key, next);
  bucket.updatedAt = now;
  ensureCapacity(bucket.network);
  schedulePersist();
}

function addDomMedia(tabId, payload) {
  if (typeof tabId !== "number" || tabId < 0) {
    return;
  }

  if (!payload || !Array.isArray(payload.items)) {
    return;
  }

  const bucket = getTabBucket(tabId);
  const now = Date.now();

  if (payload.pageTitle) {
    bucket.pageTitle = safeText(payload.pageTitle, 140);
  }

  if (payload.pageUrl) {
    bucket.pageUrl = payload.pageUrl;
  }

  for (const rawItem of payload.items) {
    const normalized = normalizeUrl(rawItem.url);
    if (!normalized) {
      continue;
    }

    if (!isLikelyMediaUrl(normalized, rawItem.mimeType || "")) {
      continue;
    }

    const domId =
      typeof rawItem.domId === "string" && rawItem.domId.trim()
        ? rawItem.domId.trim().slice(0, 64)
        : "";
    const key = domId ? `${domId}::${normalized}` : normalized;

    const previous = bucket.dom.get(key) || {};
    const next = {
      ...previous,
      url: normalized,
      domId: domId || previous.domId || "",
      lastSeen: now,
      firstSeen: previous.firstSeen || now,
      sourceDom: true,
      label: safeText(rawItem.label || previous.label || "", 140),
      duration: rawItem.duration || previous.duration || 0,
      width: rawItem.width || previous.width || 0,
      height: rawItem.height || previous.height || 0,
      pageTitle: bucket.pageTitle || previous.pageTitle || "",
      pageUrl: bucket.pageUrl || previous.pageUrl || "",
      tagName: rawItem.tagName || previous.tagName || "",
      poster: rawItem.poster || previous.poster || "",
      filenameHint: previous.filenameHint || guessFilenameFromUrl(normalized),
      rectX: toNumber(rawItem.rectX) || previous.rectX || 0,
      rectY: toNumber(rawItem.rectY) || previous.rectY || 0,
      rectWidth: toNumber(rawItem.rectWidth) || previous.rectWidth || 0,
      rectHeight: toNumber(rawItem.rectHeight) || previous.rectHeight || 0,
      domOrder: toInt(rawItem.domOrder) || previous.domOrder || 0,
      isVisible: Boolean(rawItem.isVisible || previous.isVisible),
      isPlaying: Boolean(rawItem.isPlaying || previous.isPlaying),
      inFrame: Boolean(rawItem.inFrame || previous.inFrame)
    };

    bucket.dom.set(key, next);
  }

  bucket.updatedAt = now;
  ensureCapacity(bucket.dom);
  schedulePersist();
}

function scoreItem(item) {
  let score = 0;

  if (item.sourceTags.includes("dom")) {
    score += 40;
  }

  if (item.sourceTags.includes("network")) {
    score += 30;
  }

  if (item.requestType === "media") {
    score += 20;
  }

  if ((item.mimeType || "").startsWith("video/")) {
    score += 20;
  }

  if (isLikelyMediaUrl(item.url, item.mimeType || "")) {
    score += 10;
  }

  if (item.label) {
    score += 8;
  }

  if (item.duration) {
    score += 5;
  }

  if (item.isVisible) {
    score += 8;
  }

  if (item.isPlaying) {
    score += 30;
  }

  if (item.domId) {
    score += 6;
  }

  return score;
}

function mergeMediaForTab(tabId) {
  const bucket = getTabBucket(tabId);
  const networkByUrl = bucket.network;
  const consumedNetwork = new Set();
  const items = [];

  for (const value of bucket.dom.values()) {
    const mergedDom = {
      ...value,
      sourceTags: ["dom"]
    };

    const network = networkByUrl.get(value.url);
    if (network) {
      mergeFields(mergedDom, network);
      mergedDom.requestType = network.requestType || mergedDom.requestType || "";
      mergedDom.statusCode = network.statusCode || mergedDom.statusCode || 0;
      mergedDom.method = network.method || mergedDom.method || "";
      mergedDom.initiator = network.initiator || mergedDom.initiator || "";
      if (!mergedDom.sourceTags.includes("network")) {
        mergedDom.sourceTags.push("network");
      }
      consumedNetwork.add(value.url);
    }

    items.push(mergedDom);
  }

  for (const [url, value] of networkByUrl.entries()) {
    if (consumedNetwork.has(url)) {
      continue;
    }

    items.push({
      ...value,
      url,
      sourceTags: ["network"]
    });
  }

  return items
    .map((item) => ({
      ...item,
      sourceTags: item.sourceTags || [],
      filenameHint: item.filenameHint || guessFilenameFromUrl(item.url),
      score: scoreItem(item)
    }))
    .sort((a, b) => {
      if (b.score !== a.score) {
        return b.score - a.score;
      }

      if ((b.isPlaying ? 1 : 0) !== (a.isPlaying ? 1 : 0)) {
        return (b.isPlaying ? 1 : 0) - (a.isPlaying ? 1 : 0);
      }

      if ((b.domOrder || 0) !== (a.domOrder || 0)) {
        return (a.domOrder || 0) - (b.domOrder || 0);
      }

      return (b.lastSeen || 0) - (a.lastSeen || 0);
    });
}

function clearTabData(tabId) {
  TAB_DATA.delete(tabId);
  schedulePersist();
}

function sanitizeFilename(name) {
  const compact = (name || "media")
    .replace(/[\\/:*?"<>|]+/g, "_")
    .replace(/\s+/g, " ")
    .trim();

  if (!compact) {
    return "media";
  }

  return compact.slice(0, 180);
}

chrome.webRequest.onCompleted.addListener(
  addNetworkMedia,
  { urls: ["<all_urls>"] },
  ["responseHeaders"]
);

chrome.tabs.onRemoved.addListener((tabId) => {
  clearTabData(tabId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading") {
    clearTabData(tabId);
  }
});

// ---------------------------------------------------------------------------
// B 站取流解析 / 下载
// ---------------------------------------------------------------------------
async function getBiliCookie() {
  try {
    if (typeof chrome === "undefined" || !chrome.cookies || !chrome.cookies.get) {
      return "";
    }
    const url = "https://www.bilibili.com";
    const names = ["SESSDATA", "bili_jct", "buvid3", "buvid4", "sid"];
    const parts = [];
    for (const n of names) {
      const c = await chrome.cookies.get({ url, name: n });
      if (c && c.value) {
        parts.push(n + "=" + c.value);
      }
    }
    return parts.join("; ");
  } catch {
    return "";
  }
}

let biliRefererRuleReady = false;
function ensureBiliRefererRule() {
  if (
    biliRefererRuleReady ||
    typeof chrome === "undefined" ||
    !chrome.declarativeNetRequest
  ) {
    return;
  }
  try {
    const rule = {
      id: 90001,
      priority: 1,
      action: {
        type: "modifyHeaders",
        requestHeaders: [
          { header: "Referer", operation: "set", value: "https://www.bilibili.com/" }
        ]
      },
      condition: {
        regexFilter:
          "https?://[^/]*\\.(bilivideo\\.com|akamaized\\.net|mcdn\\.bilibili\\.com)|https?://[^/]*pd\\.bilibili\\.com",
        resourceTypes: [
          "media",
          "other",
          "xmlhttprequest",
          "script",
          "stylesheet",
          "image",
          "font"
        ]
      }
    };
    chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [90001],
      addRules: [rule]
    });
    biliRefererRuleReady = true;
  } catch {
    // 权限不足时静默忽略；下载若 403，由上层提示
  }
}

async function handleBiliResolve(message, sendResponse) {
  const bvid = message.bvid;
  if (!bvid) {
    sendResponse({ ok: false, error: "缺少 bvid" });
    return;
  }
  // cid 可能为空（仅从 URL 拿到 bvid），由 resolveBilibili 内部 getView 补全
  const cid = message.cid || 0;
  try {
    const cookie = await getBiliCookie();
    const result = await globalThis.MCD_BILI.resolveBilibili({ bvid, cid, cookie });
    sendResponse({
      ok: result.ok,
      type: result.type,
      streams: result.streams,
      error: result.error
    });
  } catch (e) {
    sendResponse({ ok: false, error: (e && e.message) || String(e) });
  }
}

function doDownload(url, filename, backupUrls, onDone) {
  const list = [url].concat(Array.isArray(backupUrls) ? backupUrls : []);
  let idx = 0;
  const attempt = () => {
    if (idx >= list.length) {
      onDone(new Error("所有备用地址均下载失败"));
      return;
    }
    const u = list[idx++];
    chrome.downloads.download({ url: u, filename, saveAs: false }, (downloadId) => {
      const err = chrome.runtime.lastError;
      if (err) {
        attempt();
        return;
      }
      onDone(null, downloadId);
    });
  };
  attempt();
}

function handleBiliDownload(message, sendResponse) {
  const stream = message.stream;
  if (!stream) {
    sendResponse({ ok: false, error: "缺少下载流信息" });
    return;
  }
  ensureBiliRefererRule();

  const base = (message.filenameBase || "bilibili")
    .replace(/[\\/:*?"<>|]/g, "_")
    .slice(0, 120);
  const q = stream.qualityLabel || "";

  if (stream.kind === "mp4") {
    const filename = `${base}${q ? "-" + q : ""}${stream.filenameSuffix || ""}.mp4`;
    doDownload(stream.url, filename, stream.backupUrls, (err, downloadId) => {
      if (err) {
        sendResponse({ ok: false, error: err.message });
        return;
      }
      sendResponse({ ok: true, downloadId, kind: "mp4" });
    });
    return;
  }

  if (stream.kind === "dash") {
    const vName = `${base}${q ? "-" + q : ""}-video.mp4`;
    const aName = `${base}${q ? "-" + q : ""}-audio.m4a`;
    const results = {};
    let pending = stream.audioUrl ? 2 : 1;
    const finish = () => {
      pending--;
      if (pending > 0) {
        return;
      }
      const ok = Boolean(results.video || results.audio);
      sendResponse({
        ok,
        kind: "dash",
        video: results.video || null,
        audio: results.audio || null,
        note:
          "DASH 流视频/音频为分开的两个文件，可用 ffmpeg 合并：" +
          `ffmpeg -i "${vName}" -i "${aName}" -c copy "${base}${q}.mp4"`
      });
    };
    doDownload(stream.videoUrl, vName, stream.videoBackupUrls, (err, id) => {
      if (!err) {
        results.video = id;
      }
      finish();
    });
    if (stream.audioUrl) {
      doDownload(stream.audioUrl, aName, stream.audioBackupUrls, (err, id) => {
        if (!err) {
          results.audio = id;
        }
        finish();
      });
    }
    return;
  }

  sendResponse({ ok: false, error: "未知的视频流类型：" + stream.kind });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== "string") {
    return;
  }

  if (message.type === "DOM_MEDIA_FOUND") {
    const tabId = sender.tab && typeof sender.tab.id === "number" ? sender.tab.id : -1;
    addDomMedia(tabId, message);
    sendResponse({ ok: true });
    return;
  }

  if (message.type === "GET_MEDIA_FOR_TAB") {
    const tabId =
      typeof message.tabId === "number"
        ? message.tabId
        : sender.tab && typeof sender.tab.id === "number"
          ? sender.tab.id
          : -1;

    if (tabId < 0) {
      sendResponse({ ok: false, error: "未找到当前活动标签页。" });
      return;
    }

    sendResponse({
      ok: true,
      items: mergeMediaForTab(tabId)
    });
    return;
  }

  if (message.type === "CLEAR_MEDIA_FOR_TAB") {
    const tabId =
      typeof message.tabId === "number"
        ? message.tabId
        : sender.tab && typeof sender.tab.id === "number"
          ? sender.tab.id
          : -1;

    if (tabId >= 0) {
      clearTabData(tabId);
    }

    sendResponse({ ok: true });
    return;
  }

  if (message.type === "RESCAN_TAB") {
    const tabId =
      typeof message.tabId === "number"
        ? message.tabId
        : sender.tab && typeof sender.tab.id === "number"
          ? sender.tab.id
          : -1;

    if (typeof tabId !== "number" || tabId < 0) {
      sendResponse({ ok: false, error: "标签页 ID 无效。" });
      return;
    }

    chrome.tabs.sendMessage(tabId, { type: "REQUEST_DOM_RESCAN" }, () => {
      const err = chrome.runtime.lastError;
      if (err) {
        const msg = (err.message || "").toLowerCase();
        if (msg.includes("message port closed before a response was received")) {
          sendResponse({ ok: true });
          return;
        }

        sendResponse({ ok: false, error: err.message });
        return;
      }

      sendResponse({ ok: true });
    });
    return true;
  }

  if (message.type === "DOWNLOAD_MEDIA") {
    const url = message.url;
    if (typeof url !== "string" || !url) {
      sendResponse({ ok: false, error: "媒体链接无效。" });
      return;
    }

    if (!/^https?:/i.test(url)) {
      sendResponse({
        ok: false,
        error: "仅支持直接下载 http/https 链接。"
      });
      return;
    }

    if (/\.(m3u8|m3u|mpd)([?#]|$)/i.test(url) || /mpegurl|dash\+xml/i.test(url)) {
      sendResponse({
        ok: false,
        error: "该地址为流媒体分片列表，无法直链下载，请使用页面内「录制下载」或专门合并工具。"
      });
      return;
    }

    if (isMediaSegmentUrl(url)) {
      sendResponse({
        ok: false,
        error: "该地址为媒体分片（非完整文件），无法直链下载，请使用页面内「录制下载」。"
      });
      return;
    }

    const rawName = typeof message.filename === "string" ? message.filename : guessFilenameFromUrl(url);
    const filename = sanitizeFilename(rawName);

    chrome.downloads.download(
      {
        url,
        filename,
        saveAs: false
      },
      (downloadId) => {
        const err = chrome.runtime.lastError;
        if (err) {
          sendResponse({ ok: false, error: err.message });
          return;
        }

        sendResponse({ ok: true, downloadId });
      }
    );

    return true;
  }

  if (message.type === "BILI_RESOLVE") {
    handleBiliResolve(message, sendResponse);
    return true;
  }

  if (message.type === "BILI_DOWNLOAD") {
    handleBiliDownload(message, sendResponse);
    return true;
  }
});

// Service Worker 启动时从会话存储恢复媒体数据，避免回收后丢失
loadPersisted();
