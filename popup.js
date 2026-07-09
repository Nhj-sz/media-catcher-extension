const state = {
  tabId: null,
  items: [],
  query: "",
  biliInfo: null
};

const elements = {
  statusText: document.getElementById("statusText"),
  refreshBtn: document.getElementById("refreshBtn"),
  clearBtn: document.getElementById("clearBtn"),
  searchInput: document.getElementById("searchInput"),
  emptyState: document.getElementById("emptyState"),
  mediaList: document.getElementById("mediaList"),
  biliBox: document.getElementById("biliBox"),
  biliTitle: document.getElementById("biliTitle"),
  biliResolve: document.getElementById("biliResolve"),
  biliStreams: document.getElementById("biliStreams")
};

function setStatus(message) {
  elements.statusText.textContent = message;
}

function sendMessage(payload) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(payload, (response) => {
      const err = chrome.runtime.lastError;
      if (err) {
        const msg = (err.message || "").toLowerCase();
        if (msg.includes("message port closed before a response was received")) {
          resolve({ ok: true, ignored: true });
          return;
        }

        resolve({ ok: false, error: err.message });
        return;
      }

      resolve(response || null);
    });
  });
}

async function getActiveTabId() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs && tabs[0] ? tabs[0].id : null;
}

function sendToTab(tabId, payload) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, payload, (response) => {
      const err = chrome.runtime.lastError;
      if (err) {
        resolve({ ok: false, error: err.message });
        return;
      }
      resolve(response || null);
    });
  });
}

// ---- B 站下载入口 ----
function isBiliWatchUrl(url) {
  if (!url) {
    return false;
  }
  try {
    const u = new URL(url);
    if (!/bilibili\.com$/i.test(u.hostname)) {
      return false;
    }
    return /(^\/(video|bangumi|cheese)\/)|(b23\.tv)/i.test(u.pathname + u.search);
  } catch {
    return false;
  }
}

async function initBiliBox() {
  if (state.tabId === null) {
    return;
  }
  const tab = await chrome.tabs.get(state.tabId).catch(() => null);
  if (!tab || !isBiliWatchUrl(tab.url)) {
    elements.biliBox.style.display = "none";
    return;
  }

  const info = await sendToTab(state.tabId, { type: "BILI_GET_PAGE_INFO" });
  if (!info || !info.ok || !info.info || !info.info.bvid || !info.info.cid) {
    elements.biliBox.style.display = "none";
    return;
  }

  state.biliInfo = info.info;
  elements.biliTitle.textContent = "B站视频：" + (info.info.title || info.info.bvid);
  elements.biliBox.style.display = "";
  elements.biliStreams.innerHTML = "";
}

function renderBiliStreams(streams, titleBase) {
  elements.biliStreams.innerHTML = "";
  if (!streams || !streams.length) {
    const p = document.createElement("p");
    p.className = "bili-err";
    p.textContent = "未找到可下载流（可能需登录，或该视频受限/加密）。";
    elements.biliStreams.appendChild(p);
    return;
  }
  for (const stream of streams) {
    const row = document.createElement("div");
    row.className = "bili-row";

    const label = document.createElement("span");
    label.className = "bili-label";
    label.textContent =
      stream.kind === "mp4"
        ? "MP4 合流 " + (stream.qualityLabel || "")
        : "DASH " +
          (stream.qualityLabel || "") +
          (stream.width ? " " + stream.width + "x" + stream.height : "");

    const dl = document.createElement("button");
    dl.type = "button";
    dl.className = "btn soft";
    dl.textContent = stream.kind === "dash" ? "下载(视频+音频)" : "下载 MP4";
    dl.addEventListener("click", async () => {
      dl.disabled = true;
      dl.textContent = "下载中…";
      setStatus("已提交 B 站下载任务…");
      const resp = await sendMessage({
        type: "BILI_DOWNLOAD",
        stream,
        filenameBase: titleBase
      });
      dl.disabled = false;
      dl.textContent = stream.kind === "dash" ? "下载(视频+音频)" : "下载 MP4";
      if (!resp || !resp.ok) {
        setStatus("B 站下载失败：" + ((resp && resp.error) || "未知错误"));
        return;
      }
      if (resp.kind === "dash" && resp.note) {
        setStatus("已开始下载视频与音频两个文件。" + resp.note);
      } else {
        setStatus("已开始下载 B 站视频（MP4）。");
      }
    });

    row.appendChild(label);
    row.appendChild(dl);
    elements.biliStreams.appendChild(row);
  }
}

function wireBiliBox() {
  elements.biliResolve.addEventListener("click", async () => {
    if (!state.biliInfo) {
      return;
    }
    elements.biliResolve.disabled = true;
    elements.biliResolve.textContent = "解析中…";
    setStatus("正在向 B 站请求播放地址…");
    const resp = await sendMessage({
      type: "BILI_RESOLVE",
      bvid: state.biliInfo.bvid,
      cid: state.biliInfo.cid
    });
    elements.biliResolve.disabled = false;
    elements.biliResolve.textContent = "重新解析";

    if (!resp || !resp.ok) {
      elements.biliStreams.innerHTML = "";
      const p = document.createElement("p");
      p.className = "bili-err";
      p.textContent = "解析失败：" + ((resp && resp.error) || "未知错误");
      elements.biliStreams.appendChild(p);
      setStatus("B 站解析失败：" + ((resp && resp.error) || ""));
      return;
    }
    setStatus("B 站解析成功，共 " + (resp.streams || []).length + " 个可下载项。");
    renderBiliStreams(resp.streams, state.biliInfo.title);
  });
}

function formatBytes(bytes) {
  if (!bytes || bytes <= 0) {
    return "未知大小";
  }

  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;

  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }

  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function formatDuration(seconds) {
  if (!seconds || seconds <= 0) {
    return "时长未知";
  }

  const rounded = Math.round(seconds);
  const h = Math.floor(rounded / 3600);
  const m = Math.floor((rounded % 3600) / 60);
  const s = rounded % 60;

  if (h > 0) {
    return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }

  return `${m}:${String(s).padStart(2, "0")}`;
}

function shortUrl(url) {
  try {
    const parsed = new URL(url);
    const compactPath = parsed.pathname.length > 45 ? `${parsed.pathname.slice(0, 45)}...` : parsed.pathname;
    return `${parsed.hostname}${compactPath}`;
  } catch {
    if (!url) {
      return "";
    }

    return url.length > 70 ? `${url.slice(0, 70)}...` : url;
  }
}

function extensionFromMime(mimeType) {
  const map = {
    "video/mp4": "mp4",
    "video/webm": "webm",
    "video/quicktime": "mov",
    "application/vnd.apple.mpegurl": "m3u8",
    "application/x-mpegurl": "m3u8",
    "application/dash+xml": "mpd",
    "audio/mpeg": "mp3",
    "audio/mp4": "m4a"
  };

  return map[(mimeType || "").toLowerCase()] || "";
}

function extractExtensionFromUrl(url) {
  const matched = (url || "").match(/\.([a-z0-9]{2,5})(?:[?#]|$)/i);
  return matched ? matched[1].toLowerCase() : "";
}

function isStreamUrl(url) {
  return /\.(m3u8|m3u|mpd)([?#]|$)/i.test(url || "") || /mpegurl|dash\+xml/i.test((url || ""));
}

// 判断 URL 是否为媒体分片/碎片（MSE / HLS / DASH 的一段），单独下载只会得到片段而非完整文件。
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

// 选出真正可下载的完整文件直链：优先网络匹配直链，跳过流媒体与分片。
function pickDownloadUrl(item) {
  const urls = [item.downloadUrl, item.url].filter((u) => /^https?:/i.test(u || ""));
  for (const url of urls) {
    if (isStreamUrl(url)) {
      continue;
    }
    if (isMediaSegmentUrl(url)) {
      continue;
    }
    return url;
  }
  return "";
}

function sanitizeName(name) {
  return (name || "媒体")
    .replace(/[\\/:*?"<>|]+/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

function buildFileName(item) {
  const base = sanitizeName(item.label || item.filenameHint || "媒体") || "媒体";
  const mime = (item.mimeType || "").toLowerCase();
  const url = item.url || "";
  const looksAudio = mime.startsWith("audio/") || /\.(mp3|m4a|wav|ogg|flac|aac|webm)([?#]|$)/i.test(url);
  const looksImage = mime.startsWith("image/") || /\.(jpg|jpeg|png|webp|gif|bmp|avif|svg)([?#]|$)/i.test(url);
  const defaultExt = looksAudio ? "mp3" : looksImage ? "jpg" : "mp4";
  const ext = extractExtensionFromUrl(url) || extensionFromMime(item.mimeType) || defaultExt;
  return `${base}.${ext}`;
}

async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const helper = document.createElement("textarea");
    helper.value = text;
    document.body.appendChild(helper);
    helper.select();

    let copied = false;
    try {
      copied = document.execCommand("copy");
    } finally {
      helper.remove();
    }

    return copied;
  }
}

async function downloadItem(item) {
  const url = pickDownloadUrl(item);
  if (!url) {
    setStatus("该条目无可下载的完整文件直链（可能为分片流媒体，请用页面内「录制下载」）。");
    return;
  }

  const response = await sendMessage({
    type: "DOWNLOAD_MEDIA",
    url,
    filename: buildFileName(item)
  });

  if (!response || !response.ok) {
    setStatus(`下载失败：${response && response.error ? response.error : "未知错误"}`);
    return;
  }

  setStatus("已加入浏览器下载任务");
}

function createBadge(text) {
  const badge = document.createElement("span");
  badge.className = "badge";
  badge.textContent = text;
  return badge;
}

function renderList() {
  const q = state.query.trim().toLowerCase();
  const filtered = state.items.filter((item) => {
    if (!q) {
      return true;
    }

    const haystack = `${item.label || ""} ${item.url || ""} ${item.mimeType || ""}`.toLowerCase();
    return haystack.includes(q);
  });

  elements.mediaList.innerHTML = "";

  if (!filtered.length) {
    elements.emptyState.style.display = "block";
    return;
  }

  elements.emptyState.style.display = "none";

  for (const item of filtered) {
    const li = document.createElement("li");
    li.className = "media-item";

    const title = document.createElement("h2");
    title.className = "media-title";
    title.textContent = item.label || item.filenameHint || shortUrl(item.url) || "未命名媒体";

    const urlText = document.createElement("p");
    urlText.className = "media-url";
    urlText.textContent = shortUrl(item.url);

    const badgeRow = document.createElement("div");
    badgeRow.className = "badge-row";

    const sources = Array.isArray(item.sourceTags) ? item.sourceTags : [];
    if (sources.includes("dom")) {
      badgeRow.appendChild(createBadge("页面元素"));
    }
    if (sources.includes("network")) {
      badgeRow.appendChild(createBadge("网络捕获"));
    }
    if (item.mimeType) {
      badgeRow.appendChild(createBadge(item.mimeType));
    }

    const meta = document.createElement("p");
    meta.className = "meta";

    const parts = [formatDuration(item.duration), formatBytes(item.contentLength)];
    if (item.width && item.height) {
      parts.push(`${item.width}x${item.height}`);
    }
    meta.textContent = parts.join(" | ");

    const actionRow = document.createElement("div");
    actionRow.className = "action-row";

    const downloadBtn = document.createElement("button");
    downloadBtn.type = "button";
    downloadBtn.className = "btn primary";
    downloadBtn.textContent = "下载";

    const directUrl = pickDownloadUrl(item);
    const isStream = isStreamUrl(item.url || "");
    const isSegment = isMediaSegmentUrl(item.url || "") || isMediaSegmentUrl(item.downloadUrl || "");
    if (isStream) {
      downloadBtn.disabled = true;
      downloadBtn.title = "流媒体为分片列表，需借助专门合并工具下载。";
    } else if (isSegment) {
      downloadBtn.disabled = true;
      downloadBtn.title = "该地址为媒体分片（非完整文件），无法直链下载，请使用页面内「录制下载」。";
    } else if (!directUrl) {
      downloadBtn.disabled = true;
      downloadBtn.title = "blob/data 地址或暂无可下载直链";
    }

    downloadBtn.addEventListener("click", () => {
      downloadItem(item);
    });

    const copyBtn = document.createElement("button");
    copyBtn.type = "button";
    copyBtn.className = "btn secondary";
    copyBtn.textContent = "复制链接";
    copyBtn.addEventListener("click", async () => {
      const ok = await copyToClipboard(item.url);
      setStatus(ok ? "已复制链接" : "复制失败");
    });

    const openBtn = document.createElement("button");
    openBtn.type = "button";
    openBtn.className = "btn link";
    openBtn.textContent = "打开";
    openBtn.addEventListener("click", () => {
      chrome.tabs.create({ url: item.url });
    });

    actionRow.appendChild(downloadBtn);
    actionRow.appendChild(copyBtn);
    actionRow.appendChild(openBtn);

    li.appendChild(title);
    li.appendChild(urlText);
    li.appendChild(badgeRow);
    li.appendChild(meta);
    li.appendChild(actionRow);

    elements.mediaList.appendChild(li);
  }
}

async function loadMedia() {
  if (state.tabId === null) {
    setStatus("无法识别当前标签页");
    return;
  }

  await sendMessage({ type: "RESCAN_TAB", tabId: state.tabId });
  const response = await sendMessage({ type: "GET_MEDIA_FOR_TAB", tabId: state.tabId });

  if (!response || !response.ok) {
    setStatus("读取捕获结果失败");
    return;
  }

  state.items = Array.isArray(response.items) ? response.items : [];
  renderList();
  setStatus(`捕获 ${state.items.length} 条媒体资源`);
}

async function clearMedia() {
  if (state.tabId === null) {
    return;
  }

  await sendMessage({ type: "CLEAR_MEDIA_FOR_TAB", tabId: state.tabId });
  state.items = [];
  renderList();
  setStatus("已清空当前页缓存");
}

async function bootstrap() {
  state.tabId = await getActiveTabId();

  elements.refreshBtn.addEventListener("click", () => {
    loadMedia();
  });

  elements.clearBtn.addEventListener("click", () => {
    clearMedia();
  });

  elements.searchInput.addEventListener("input", (event) => {
    state.query = event.target.value || "";
    renderList();
  });

  wireBiliBox();
  await loadMedia();
  await initBiliBox();
}

bootstrap().catch((error) => {
  setStatus(`初始化失败：${error && error.message ? error.message : String(error)}`);
});
