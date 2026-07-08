const MAX_DOM_ITEMS = 260;
const MEDIA_EXT_RE = /\.(mp4|webm|m3u8|mpd|mov|m4v|flv|avi|mkv|ts|mp3|m4a|aac|ogg|wav)([?#]|$)/i;
const IMAGE_EXT_RE = /\.(jpg|jpeg|png|webp|gif|bmp|avif|svg)([?#]|$)/i;
const AUDIO_EXT_RE = /\.(mp3|m4a|aac|ogg|wav|flac|opus)([?#]|$)/i;
const MAX_IMAGE_ITEMS = 80;
const APP_ROOT_ID = "mcd-root-host";
const PAGE_STYLE_ID = "mcd-page-style";
const PANEL_AUTO_REFRESH_MS = 2600;
const HIGHLIGHT_VISIBLE_MS = 2000;
const MIN_SCAN_INTERVAL_CLOSED_MS = 1800;
const IS_TOP_FRAME = window === window.top;

const state = {
  nextDomId: 1,
  nextDisplayId: 1,
  domIdToVideo: new Map(),
  displayIdByDomId: new Map(),
  releasedDisplayIds: [],
  placeholdersByDomId: new Map(),
  badgeRecords: [],
  scheduledScanTimer: null,
  scheduledBadgeTimer: null,
  scheduledPanelRefreshTimer: null,
  panelRefreshInterval: null,
  lastScanAt: 0,
  uiReady: false,
  uiOpen: false,
  selectedDomId: "",
  highlightDomId: "",
  highlightClearTimer: null,
  panelQuery: "",
  panelItems: [],
  lastFilteredItems: [],
  mediaTypeFilter: "all",
  onlyPlayingOnly: false,
  isBatchDownloading: false,
  recordingSessions: new Map(),
  extensionContextAlive: true,
  extensionErrorNotified: false,
  noticeHideTimer: null,
  focusBurstTimer: null,
  focusOverlayRaf: null,
  panelDrag: {
    active: false,
    pointerId: null,
    startX: 0,
    startY: 0,
    startLeft: 0,
    startTop: 0
  },
  domObserver: null,
  shadow: null,
  elements: null
};

function getRuntimeSafe() {
  try {
    if (typeof chrome === "undefined" || !chrome.runtime) {
      return null;
    }

    return chrome.runtime;
  } catch {
    return null;
  }
}

function isContextInvalidError(errorLike) {
  const message = (
    typeof errorLike === "string"
      ? errorLike
      : errorLike && errorLike.message
        ? errorLike.message
        : ""
  ).toLowerCase();

  return message.includes("extension context invalidated") || message.includes("context invalidated");
}

function showTopNotice(message, sticky = true) {
  if (!state.elements || !state.elements.notice) {
    return;
  }

  const notice = state.elements.notice;
  notice.textContent = message;
  notice.classList.add("show");

  if (state.noticeHideTimer) {
    clearTimeout(state.noticeHideTimer);
    state.noticeHideTimer = null;
  }

  if (!sticky) {
    state.noticeHideTimer = setTimeout(() => {
      notice.classList.remove("show");
      state.noticeHideTimer = null;
    }, 3600);
  }
}

function disableExtensionBridge(reason = "扩展上下文已失效，请刷新页面后重试。") {
  if (!state.extensionContextAlive) {
    return;
  }

  state.extensionContextAlive = false;
  stopAllRecordingSessions();

  if (state.scheduledScanTimer) {
    clearTimeout(state.scheduledScanTimer);
    state.scheduledScanTimer = null;
  }

  if (state.scheduledBadgeTimer) {
    clearTimeout(state.scheduledBadgeTimer);
    state.scheduledBadgeTimer = null;
  }

  if (state.scheduledPanelRefreshTimer) {
    clearTimeout(state.scheduledPanelRefreshTimer);
    state.scheduledPanelRefreshTimer = null;
  }

  if (state.panelRefreshInterval) {
    clearInterval(state.panelRefreshInterval);
    state.panelRefreshInterval = null;
  }

  if (state.domObserver) {
    try {
      state.domObserver.disconnect();
    } catch {
      // ignore observer teardown errors
    }
    state.domObserver = null;
  }

  if (!state.uiReady && IS_TOP_FRAME) {
    ensureUi();
  }

  if (state.elements && state.elements.launcher) {
    state.elements.launcher.disabled = true;
    state.elements.launcher.title = "扩展已更新或失效，请刷新页面后恢复。";
    state.elements.launcher.textContent = "请刷新页面";
  }

  showTopNotice(reason, true);

  if (!state.extensionErrorNotified) {
    state.extensionErrorNotified = true;
    setStatus(reason);
  }
}

window.addEventListener(
  "error",
  (event) => {
    const errorLike = event && (event.error || event.message);
    if (!isContextInvalidError(errorLike)) {
      return;
    }

    disableExtensionBridge("扩展已更新，请刷新当前页面后继续使用。");
    event.preventDefault();
  },
  true
);

window.addEventListener("unhandledrejection", (event) => {
  const reason = event && event.reason;
  if (!isContextInvalidError(reason)) {
    return;
  }

  disableExtensionBridge("扩展已更新，请刷新当前页面后继续使用。");
  event.preventDefault();
});

function normalizeDomUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== "string") {
    return "";
  }

  if (rawUrl.startsWith("blob:") || rawUrl.startsWith("data:")) {
    return rawUrl;
  }

  try {
    return new URL(rawUrl, window.location.href).href;
  } catch {
    return rawUrl;
  }
}

function isLikelyMediaLink(url) {
  if (!url) {
    return false;
  }

  if (url.startsWith("blob:")) {
    return true;
  }

  if (MEDIA_EXT_RE.test(url)) {
    return true;
  }

  return /[?&](mime|type|format)=([^&#]*(video|audio))/i.test(url);
}

function isLikelyImageLink(url) {
  if (!url) {
    return false;
  }

  if (url.startsWith("blob:")) {
    return true;
  }

  if (IMAGE_EXT_RE.test(url)) {
    return true;
  }

  return /[?&](mime|type|format)=([^&#]*image)/i.test(url);
}

function cleanText(text, maxLength = 120) {
  if (typeof text !== "string") {
    return "";
  }

  const compact = text.replace(/\s+/g, " ").trim();
  if (!compact) {
    return "";
  }

  return compact.length > maxLength ? `${compact.slice(0, maxLength)}...` : compact;
}

function firstMeaningfulText(elements) {
  for (const element of elements) {
    if (!element) {
      continue;
    }

    const content = cleanText(element.textContent || "", 140);
    if (content) {
      return content;
    }
  }

  return "";
}

function guessVideoLabel(video) {
  if (!video) {
    return cleanText(document.title || "", 140);
  }

  const attributeLabel = cleanText(
    video.getAttribute("title") ||
      video.getAttribute("aria-label") ||
      video.getAttribute("data-title") ||
      "",
    140
  );

  if (attributeLabel) {
    return attributeLabel;
  }

  const figure = video.closest("figure");
  if (figure) {
    const caption = figure.querySelector("figcaption");
    const text = cleanText(caption ? caption.textContent || "" : "", 140);
    if (text) {
      return text;
    }
  }

  const container = video.closest("article,section,main,aside,li,div");
  if (container) {
    const heading = container.querySelector("h1,h2,h3,h4,h5,h6");
    const headingText = cleanText(heading ? heading.textContent || "" : "", 140);
    if (headingText) {
      return headingText;
    }
  }

  const nearText = firstMeaningfulText([
    video.previousElementSibling,
    video.parentElement,
    video.parentElement ? video.parentElement.previousElementSibling : null
  ]);

  if (nearText) {
    return nearText;
  }

  return cleanText(document.title || "", 140);
}

function formatRect(rect) {
  return {
    x: Number.isFinite(rect.left) ? Math.round(rect.left) : 0,
    y: Number.isFinite(rect.top) ? Math.round(rect.top) : 0,
    width: Number.isFinite(rect.width) ? Math.round(rect.width) : 0,
    height: Number.isFinite(rect.height) ? Math.round(rect.height) : 0
  };
}

function isVideoVisible(rect) {
  if (!rect) {
    return false;
  }

  if (rect.width < 8 || rect.height < 8) {
    return false;
  }

  return rect.bottom > 0 && rect.right > 0 && rect.top < window.innerHeight && rect.left < window.innerWidth;
}

function getOrAssignDomId(element, prefix = "v") {
  const existing = element.getAttribute("data-mcd-dom-id");
  if (existing) {
    state.domIdToVideo.set(existing, element);
    return existing;
  }

  const domId = `${prefix}${state.nextDomId++}`;
  element.setAttribute("data-mcd-dom-id", domId);
  state.domIdToVideo.set(domId, element);
  return domId;
}

function releaseDisplayId(domId) {
  const displayId = state.displayIdByDomId.get(domId);
  if (!displayId) {
    return;
  }

  state.displayIdByDomId.delete(domId);

  if (!state.releasedDisplayIds.includes(displayId)) {
    state.releasedDisplayIds.push(displayId);
    state.releasedDisplayIds.sort((a, b) => a - b);
  }
}

function assignDisplayId(domId) {
  if (!domId) {
    return 0;
  }

  const existing = state.displayIdByDomId.get(domId);
  if (existing) {
    return existing;
  }

  const displayId = state.releasedDisplayIds.length
    ? state.releasedDisplayIds.shift()
    : state.nextDisplayId++;

  state.displayIdByDomId.set(domId, displayId);
  return displayId;
}

function toDisplayLabel(displayId, kind = "v") {
  if (displayId <= 0) {
    return "";
  }

  const prefix = kind === "i" ? "I" : kind === "a" ? "A" : "V";
  return `${prefix}${displayId}`;
}

function pruneDomRegistry() {
  for (const [domId, element] of state.domIdToVideo.entries()) {
    if (!element || !document.contains(element)) {
      stopRecordingByDomId(domId, false);
      releaseDisplayId(domId);
      state.domIdToVideo.delete(domId);
    }
  }
}

function collectFromVideo(video, domOrder) {
  const domId = getOrAssignDomId(video, "v");
  const displayId = assignDisplayId(domId);
  const displayLabel = toDisplayLabel(displayId, "v");
  const rect = video.getBoundingClientRect();
  const rectInfo = formatRect(rect);
  const visible = isVideoVisible(rect);
  const playing = !video.paused && !video.ended && Number.isFinite(video.currentTime) && video.currentTime > 0;

  const base = {
    domId,
    displayId,
    displayLabel,
    domOrder,
    label: guessVideoLabel(video),
    duration: Number.isFinite(video.duration) ? Math.round(video.duration * 10) / 10 : 0,
    width: Number.isFinite(video.videoWidth) ? video.videoWidth : 0,
    height: Number.isFinite(video.videoHeight) ? video.videoHeight : 0,
    poster: video.poster || "",
    tagName: (video.tagName || "video").toLowerCase(),
    rectX: rectInfo.x,
    rectY: rectInfo.y,
    rectWidth: rectInfo.width,
    rectHeight: rectInfo.height,
    isVisible: visible,
    isPlaying: playing,
    inFrame: !IS_TOP_FRAME
  };

  const candidateUrls = new Set();
  const pushUrl = (value) => {
    const normalized = normalizeDomUrl(value);
    if (!normalized || !isLikelyMediaLink(normalized)) {
      return;
    }
    candidateUrls.add(normalized);
  };

  pushUrl(video.currentSrc);
  pushUrl(video.src);

  for (const source of video.querySelectorAll("source")) {
    pushUrl(source.src || source.getAttribute("src"));
  }

  const items = [...candidateUrls].map((url) => ({
    ...base,
    url
  }));

  const placeholder = items.length
    ? null
    : {
        ...base,
        url: "",
        sourceTags: ["dom"],
        filenameHint: `视频-${displayLabel || domId}`,
        isPlaceholder: true
      };

  const badgeRecord = {
    domId,
    displayId,
    displayLabel,
    label: base.label,
    rectX: base.rectX,
    rectY: base.rectY,
    rectWidth: base.rectWidth,
    rectHeight: base.rectHeight,
    isVisible: base.isVisible,
    isPlaying: base.isPlaying
  };

  return { items, placeholder, badgeRecord };
}

function collectFromImage(image, domOrder) {
  const rect = image.getBoundingClientRect();
  const rectInfo = formatRect(rect);
  if (rectInfo.width < 120 || rectInfo.height < 80 || rectInfo.width * rectInfo.height < 12000) {
    return null;
  }

  const imageUrl = normalizeDomUrl(
    image.currentSrc ||
      image.src ||
      image.getAttribute("src") ||
      image.getAttribute("data-src") ||
      image.getAttribute("data-original") ||
      image.getAttribute("data-lazy-src") ||
      ""
  );

  if (!imageUrl || imageUrl.startsWith("data:")) {
    return null;
  }

  if (!isLikelyImageLink(imageUrl) && !/^https?:|^blob:/i.test(imageUrl)) {
    return null;
  }

  const domId = getOrAssignDomId(image, "i");
  const displayId = assignDisplayId(domId);
  const displayLabel = toDisplayLabel(displayId, "i");
  const label =
    cleanText(image.getAttribute("alt") || image.getAttribute("title") || "", 140) ||
    cleanText(document.title || "", 140);

  const item = {
    url: imageUrl,
    domId,
    displayId,
    displayLabel,
    domOrder,
    label,
    duration: 0,
    width: rectInfo.width,
    height: rectInfo.height,
    poster: "",
    tagName: "img",
    rectX: rectInfo.x,
    rectY: rectInfo.y,
    rectWidth: rectInfo.width,
    rectHeight: rectInfo.height,
    isVisible: true,
    isPlaying: false,
    inFrame: !IS_TOP_FRAME,
    sourceTags: ["dom"],
    filenameHint: `图片-${displayLabel || domId}`
  };

  const badgeRecord = {
    domId,
    displayId,
    displayLabel,
    label,
    rectX: rectInfo.x,
    rectY: rectInfo.y,
    rectWidth: rectInfo.width,
    rectHeight: rectInfo.height,
    isVisible: true,
    isPlaying: false
  };

  return { item, badgeRecord };
}

function collectFromAudio(audio, domOrder) {
  if (!audio) {
    return null;
  }

  const candidateUrls = new Set();
  const pushUrl = (value) => {
    const normalized = normalizeDomUrl(value);
    if (!normalized || !isLikelyMediaLink(normalized)) {
      return;
    }
    candidateUrls.add(normalized);
  };

  pushUrl(audio.currentSrc);
  pushUrl(audio.src);

  for (const source of audio.querySelectorAll("source")) {
    pushUrl(source.src || source.getAttribute("src"));
  }

  if (!candidateUrls.size) {
    return null;
  }

  const domId = getOrAssignDomId(audio, "a");
  const displayId = assignDisplayId(domId);
  const displayLabel = toDisplayLabel(displayId, "a");
  const label =
    cleanText(
      audio.getAttribute("title") ||
        audio.getAttribute("aria-label") ||
        audio.getAttribute("data-title") ||
        "",
      140
    ) || cleanText(document.title || "", 140);
  const playing = !audio.paused && !audio.ended;

  const items = [...candidateUrls].map((url) => ({
    domId,
    displayId,
    displayLabel,
    domOrder,
    url,
    label,
    duration: Number.isFinite(audio.duration) ? Math.round(audio.duration * 10) / 10 : 0,
    width: 0,
    height: 0,
    poster: "",
    tagName: "audio",
    rectX: 0,
    rectY: 0,
    rectWidth: 0,
    rectHeight: 0,
    isVisible: true,
    isPlaying: playing,
    inFrame: !IS_TOP_FRAME,
    sourceTags: ["dom"],
    filenameHint: `音频-${displayLabel || domId}`
  }));

  const badgeRecord = {
    domId,
    displayId,
    displayLabel,
    label,
    rectX: 0,
    rectY: 0,
    rectWidth: 0,
    rectHeight: 0,
    isVisible: true,
    isPlaying: playing
  };

  return { items, badgeRecord };
}

function collectFromAnchors() {
  const links = [];

  for (const anchor of document.querySelectorAll("a[href]")) {
    if (links.length >= MAX_DOM_ITEMS) {
      break;
    }

    const href = normalizeDomUrl(anchor.getAttribute("href") || "");
    if (!isLikelyMediaLink(href)) {
      continue;
    }

    links.push({
      url: href,
      domId: "",
      domOrder: 0,
      label: cleanText(anchor.textContent || "", 140) || cleanText(document.title || "", 140),
      duration: 0,
      width: 0,
      height: 0,
      poster: "",
      tagName: "a",
      rectX: 0,
      rectY: 0,
      rectWidth: 0,
      rectHeight: 0,
      isVisible: false,
      isPlaying: false
    });
  }

  return links;
}

function buildPayload() {
  pruneDomRegistry();

  const byKey = new Map();
  const placeholdersByDomId = new Map();
  const badgeRecords = [];
  const videos = [...document.querySelectorAll("video")];

  let domOrder = 0;
  for (const video of videos) {
    domOrder += 1;
    const { items, placeholder, badgeRecord } = collectFromVideo(video, domOrder);
    badgeRecords.push(badgeRecord);

    for (const item of items) {
      const key = item.domId ? `${item.domId}::${item.url}` : item.url;
      if (!byKey.has(key)) {
        byKey.set(key, item);
      }
    }

    if (placeholder) {
      placeholdersByDomId.set(placeholder.domId, placeholder);
    }

    if (byKey.size >= MAX_DOM_ITEMS) {
      break;
    }
  }

  const shouldCollectImages =
    state.uiOpen ||
    state.mediaTypeFilter === "image" ||
    (state.selectedDomId && state.selectedDomId.startsWith("i")) ||
    (state.highlightDomId && state.highlightDomId.startsWith("i"));

  if (byKey.size < MAX_DOM_ITEMS && shouldCollectImages) {
    const images = [...document.querySelectorAll("img")];
    let imageCount = 0;

    for (const image of images) {
      if (imageCount >= MAX_IMAGE_ITEMS || byKey.size >= MAX_DOM_ITEMS) {
        break;
      }

      domOrder += 1;
      const collected = collectFromImage(image, domOrder);
      if (!collected) {
        continue;
      }

      imageCount += 1;
      const key = `${collected.item.domId}::${collected.item.url}`;
      if (!byKey.has(key)) {
        byKey.set(key, collected.item);
        badgeRecords.push(collected.badgeRecord);
      }
    }
  }

  if (byKey.size < MAX_DOM_ITEMS) {
    for (const item of collectFromAnchors()) {
      const key = item.url;
      if (!byKey.has(key)) {
        byKey.set(key, item);
      }

      if (byKey.size >= MAX_DOM_ITEMS) {
        break;
      }
    }
  }

  if (byKey.size < MAX_DOM_ITEMS) {
    const audios = [...document.querySelectorAll("audio")];
    for (const audio of audios) {
      if (byKey.size >= MAX_DOM_ITEMS) {
        break;
      }

      domOrder += 1;
      const collected = collectFromAudio(audio, domOrder);
      if (!collected || !collected.items.length) {
        continue;
      }

      let addedAudio = false;
      for (const item of collected.items) {
        const key = `${item.domId}::${item.url}`;
        if (!byKey.has(key)) {
          byKey.set(key, item);
          addedAudio = true;
        }
      }

      if (addedAudio) {
        badgeRecords.push(collected.badgeRecord);
      }
    }
  }

  const now = Date.now();
  const items = [...byKey.values()].slice(0, MAX_DOM_ITEMS).map((item) => ({
    ...item,
    pageTitle: cleanText(document.title || "", 140),
    pageUrl: window.location.href,
    lastSeen: now
  }));

  badgeRecords.sort((a, b) => {
    if ((a.displayId || 0) && (b.displayId || 0) && a.displayId !== b.displayId) {
      return a.displayId - b.displayId;
    }

    if ((a.rectY || 0) !== (b.rectY || 0)) {
      return (a.rectY || 0) - (b.rectY || 0);
    }

    return (a.rectX || 0) - (b.rectX || 0);
  });

  return {
    items,
    placeholdersByDomId,
    badgeRecords
  };
}

function runtimeSendMessage(payload) {
  return new Promise((resolve) => {
    if (!state.extensionContextAlive) {
      resolve({ ok: false, error: "扩展上下文已失效，请刷新页面。" });
      return;
    }

    const runtime = getRuntimeSafe();
    if (!runtime || !runtime.id || typeof runtime.sendMessage !== "function") {
      disableExtensionBridge("扩展上下文已失效，请刷新页面后重试。");
      resolve({ ok: false, error: "扩展上下文已失效，请刷新页面。" });
      return;
    }

    try {
      runtime.sendMessage(payload, (response) => {
        try {
          const runtimeInCallback = getRuntimeSafe();
          const err = runtimeInCallback ? runtimeInCallback.lastError : null;
          if (err) {
            const msg = (err.message || "").toLowerCase();
            const fireAndForget = payload && (payload.type === "DOM_MEDIA_FOUND" || payload.type === "RESCAN_TAB");
            if (msg.includes("message port closed before a response was received") && fireAndForget) {
              resolve({ ok: true, ignored: true });
              return;
            }

            if (isContextInvalidError(err)) {
              disableExtensionBridge("扩展已更新，请刷新当前页面后继续使用。");
            }

            resolve({ ok: false, error: err.message });
            return;
          }

          resolve(response || { ok: true });
        } catch (callbackError) {
          if (isContextInvalidError(callbackError)) {
            disableExtensionBridge("扩展已更新，请刷新当前页面后继续使用。");
          }

          resolve({
            ok: false,
            error: callbackError && callbackError.message ? callbackError.message : String(callbackError)
          });
        }
      });
    } catch (error) {
      if (isContextInvalidError(error)) {
        disableExtensionBridge("扩展已更新，请刷新当前页面后继续使用。");
      }

      resolve({ ok: false, error: error && error.message ? error.message : String(error) });
    }
  });
}

function ensurePageStyle() {
  if (document.getElementById(PAGE_STYLE_ID)) {
    return;
  }

  const style = document.createElement("style");
  style.id = PAGE_STYLE_ID;
  style.textContent = `
@keyframes mcd-focus-pulse {
  0% {
    box-shadow: 0 0 0 3px rgba(250, 204, 21, 0.95), 0 0 0 8px rgba(245, 158, 11, 0.35), 0 0 28px rgba(245, 158, 11, 0.55);
  }
  50% {
    box-shadow: 0 0 0 3px rgba(250, 204, 21, 0.95), 0 0 0 13px rgba(245, 158, 11, 0.28), 0 0 36px rgba(234, 88, 12, 0.6);
  }
  100% {
    box-shadow: 0 0 0 3px rgba(250, 204, 21, 0.95), 0 0 0 8px rgba(245, 158, 11, 0.35), 0 0 28px rgba(245, 158, 11, 0.55);
  }
}

@keyframes mcd-focus-burst {
  0% {
    box-shadow: 0 0 0 4px rgba(253, 224, 71, 0.95), 0 0 0 10px rgba(251, 191, 36, 0.75), 0 0 0 18px rgba(245, 158, 11, 0.5), 0 0 46px rgba(234, 88, 12, 0.85);
  }
  100% {
    box-shadow: 0 0 0 4px rgba(253, 224, 71, 0.95), 0 0 0 12px rgba(251, 191, 36, 0), 0 0 0 22px rgba(245, 158, 11, 0), 0 0 12px rgba(234, 88, 12, 0.2);
  }
}

[data-mcd-dom-id][data-mcd-focused="1"] {
  outline: 4px solid #facc15 !important;
  outline-offset: 2px !important;
  border-radius: 4px !important;
  box-shadow: 0 0 0 3px rgba(250, 204, 21, 0.95), 0 0 0 9px rgba(245, 158, 11, 0.35), 0 0 30px rgba(245, 158, 11, 0.58) !important;
  animation: mcd-focus-pulse 1.1s ease-in-out infinite !important;
  z-index: 2147482500 !important;
  position: relative !important;
}

[data-mcd-dom-id][data-mcd-focus-burst="1"] {
  animation: mcd-focus-burst 0.85s ease-out 1, mcd-focus-pulse 1.1s ease-in-out infinite !important;
}
`;
  (document.head || document.documentElement).appendChild(style);
}

function ensureUi() {
  if (!IS_TOP_FRAME) {
    return;
  }

  if (state.uiReady) {
    return;
  }

  const existing = document.getElementById(APP_ROOT_ID);
  const host = existing || document.createElement("div");
  host.id = APP_ROOT_ID;

  if (!existing) {
    (document.documentElement || document.body).appendChild(host);
  }

  const shadow = host.shadowRoot || host.attachShadow({ mode: "open" });
  state.shadow = shadow;

  shadow.innerHTML = `
<style>
:host {
  all: initial;
}
.mcd-root {
  position: fixed;
  inset: 0;
  pointer-events: none;
  z-index: 2147483000;
  font-family: "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
  color: #132036;
}
.mcd-notice {
  position: fixed;
  top: 12px;
  left: 50%;
  transform: translateX(-50%) translateY(-10px);
  min-width: 260px;
  max-width: min(88vw, 760px);
  border-radius: 10px;
  padding: 9px 14px;
  font-size: 12px;
  font-weight: 700;
  text-align: center;
  color: #fff7ed;
  background: linear-gradient(135deg, #b91c1c 0%, #ea580c 100%);
  box-shadow: 0 10px 24px rgba(127, 29, 29, 0.35);
  opacity: 0;
  transition: opacity 0.2s ease, transform 0.2s ease;
  pointer-events: none;
}
.mcd-notice.show {
  opacity: 1;
  transform: translateX(-50%) translateY(0);
}
.mcd-focus-box {
  position: fixed;
  left: 0;
  top: 0;
  width: 0;
  height: 0;
  border: 4px solid #fde047;
  border-radius: 8px;
  box-shadow: 0 0 0 2px rgba(253, 224, 71, 0.95), 0 0 0 8px rgba(245, 158, 11, 0.35), 0 0 38px rgba(245, 158, 11, 0.66), 0 0 0 9999px rgba(2, 6, 23, 0.2);
  opacity: 0;
  transform: scale(0.98);
  transition: opacity 0.14s ease, transform 0.14s ease;
  pointer-events: none;
}
.mcd-focus-box.show {
  opacity: 1;
  transform: scale(1);
}
.mcd-launcher {
  position: fixed;
  right: 18px;
  bottom: 18px;
  border: none;
  border-radius: 999px;
  padding: 10px 14px;
  background: linear-gradient(135deg, #0f62fe 0%, #1761d1 100%);
  color: #ffffff;
  font-size: 12px;
  font-weight: 700;
  box-shadow: 0 8px 18px rgba(18, 62, 144, 0.36);
  cursor: pointer;
  pointer-events: auto;
}
.mcd-panel {
  position: fixed;
  right: 18px;
  top: 68px;
  width: 420px;
  max-height: 82vh;
  min-width: 320px;
  min-height: 280px;
  border: 1px solid #cfd8ea;
  border-radius: 14px;
  overflow: hidden;
  background: #ffffff;
  box-shadow: 0 16px 36px rgba(9, 32, 77, 0.18);
  display: none;
  flex-direction: column;
  pointer-events: auto;
  resize: both;
}
.mcd-panel.open {
  display: flex;
}
.mcd-head {
  padding: 10px;
  border-bottom: 1px solid #e5ebf7;
  display: flex;
  gap: 6px;
  align-items: center;
  cursor: move;
  user-select: none;
}
.mcd-title {
  margin: 0;
  font-size: 13px;
  font-weight: 700;
  flex: 1;
}
.mcd-btn {
  border: none;
  border-radius: 8px;
  font-size: 11px;
  font-weight: 600;
  padding: 6px 8px;
  cursor: pointer;
}
.mcd-btn.mcd-ghost {
  background: #e7eefc;
  color: #1d3f78;
}
.mcd-btn.mcd-danger {
  background: #fee2e2;
  color: #991b1b;
}
.mcd-btn.mcd-primary {
  background: #2563eb;
  color: #ffffff;
}
.mcd-btn.mcd-soft {
  background: #f1f5f9;
  color: #1e293b;
}
.mcd-btn:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}
.mcd-tools {
  padding: 8px 10px;
  border-bottom: 1px solid #edf2fa;
  display: flex;
  gap: 8px;
  align-items: center;
}
.mcd-tools.secondary {
  padding-top: 6px;
  flex-wrap: wrap;
}
.mcd-tools .mcd-btn {
  white-space: nowrap;
}
.mcd-input {
  flex: 1;
  border: 1px solid #c6d2e8;
  border-radius: 8px;
  padding: 7px 9px;
  font-size: 12px;
}
.mcd-btn.mcd-mini {
  font-size: 10px;
  padding: 5px 7px;
}
.mcd-btn.is-active {
  background: #dbeafe;
  color: #1d4ed8;
  box-shadow: inset 0 0 0 1px rgba(37, 99, 235, 0.3);
}
.mcd-status {
  padding: 8px 10px;
  font-size: 11px;
  color: #344155;
  border-bottom: 1px solid #edf2fa;
  background: #f8fbff;
}
.mcd-list {
  list-style: none;
  margin: 0;
  padding: 8px;
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.mcd-item {
  border: 1px solid #d9e2f2;
  border-radius: 10px;
  background: #ffffff;
  padding: 8px;
}
.mcd-item.is-selected {
  border-color: #2563eb;
  box-shadow: 0 0 0 1px rgba(37, 99, 235, 0.2);
}
.mcd-item-title {
  margin: 0;
  font-size: 12px;
  line-height: 1.35;
}
.mcd-item-url {
  margin: 5px 0;
  font-size: 10px;
  color: #334155;
  word-break: break-all;
}
.mcd-item-meta {
  margin: 0;
  font-size: 10px;
  color: #475569;
}
.mcd-chip-row {
  margin-top: 6px;
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.mcd-chip {
  border-radius: 999px;
  font-size: 9px;
  padding: 2px 6px;
  background: #eaf1ff;
  color: #1d4ed8;
}
.mcd-actions {
  margin-top: 8px;
  display: flex;
  gap: 6px;
}
.mcd-actions .mcd-btn {
  flex: 1;
}
.mcd-empty {
  border: 1px dashed #bfd0eb;
  border-radius: 10px;
  color: #4b5563;
  background: #f9fbff;
  padding: 12px;
  font-size: 12px;
  text-align: center;
}
.mcd-badge-layer {
  position: fixed;
  inset: 0;
  pointer-events: none;
}
.mcd-badge {
  position: fixed;
  border: none;
  border-radius: 999px;
  padding: 2px 8px;
  font-size: 10px;
  font-weight: 700;
  background: #0f172a;
  color: #ffffff;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.28);
  pointer-events: auto;
  cursor: pointer;
}
.mcd-badge.is-playing {
  background: #dc2626;
}
.mcd-badge.is-selected {
  background: #2563eb;
}
@media (max-width: 820px) {
  .mcd-panel {
    left: 10px;
    right: 10px;
    width: auto;
    top: 52px;
    max-height: 78vh;
  }
  .mcd-launcher {
    right: 10px;
    bottom: 10px;
  }
}
</style>
<div class="mcd-root">
  <div id="mcdNotice" class="mcd-notice" role="status" aria-live="polite"></div>
  <div id="mcdFocusBox" class="mcd-focus-box"></div>
  <button id="mcdLauncher" class="mcd-launcher" type="button" title="打开视频面板（Alt+V）">视频面板</button>
  <section id="mcdPanel" class="mcd-panel" aria-label="媒体面板">
    <div id="mcdPanelHead" class="mcd-head">
      <h2 class="mcd-title">抓媒酱</h2>
      <button id="mcdRefresh" class="mcd-btn mcd-ghost" type="button">刷新</button>
      <button id="mcdClose" class="mcd-btn mcd-soft" type="button">隐藏</button>
    </div>
    <div class="mcd-tools">
      <input id="mcdSearch" class="mcd-input" type="search" placeholder="按标题或链接搜索" />
      <button id="mcdTypeFilter" class="mcd-btn mcd-soft" type="button">类型: 全部</button>
      <button id="mcdOnlyPlaying" class="mcd-btn mcd-soft" type="button">仅播放中: 关</button>
      <button id="mcdClear" class="mcd-btn mcd-danger" type="button">清空</button>
    </div>
    <div class="mcd-tools secondary">
      <button id="mcdBatchDownload" class="mcd-btn mcd-primary" type="button">批量下载</button>
      <button id="mcdExportTxt" class="mcd-btn mcd-ghost mcd-mini" type="button">导出TXT</button>
      <button id="mcdExportCsv" class="mcd-btn mcd-ghost mcd-mini" type="button">导出CSV</button>
      <button id="mcdExportJson" class="mcd-btn mcd-ghost mcd-mini" type="button">导出JSON</button>
    </div>
    <div id="mcdStatus" class="mcd-status">准备就绪</div>
    <ul id="mcdList" class="mcd-list"></ul>
  </section>
  <div id="mcdBadgeLayer" class="mcd-badge-layer"></div>
</div>
`;

  state.elements = {
    notice: shadow.getElementById("mcdNotice"),
    focusBox: shadow.getElementById("mcdFocusBox"),
    launcher: shadow.getElementById("mcdLauncher"),
    panel: shadow.getElementById("mcdPanel"),
    panelHead: shadow.getElementById("mcdPanelHead"),
    refreshBtn: shadow.getElementById("mcdRefresh"),
    closeBtn: shadow.getElementById("mcdClose"),
    typeFilterBtn: shadow.getElementById("mcdTypeFilter"),
    onlyPlayingBtn: shadow.getElementById("mcdOnlyPlaying"),
    clearBtn: shadow.getElementById("mcdClear"),
    batchDownloadBtn: shadow.getElementById("mcdBatchDownload"),
    exportTxtBtn: shadow.getElementById("mcdExportTxt"),
    exportCsvBtn: shadow.getElementById("mcdExportCsv"),
    exportJsonBtn: shadow.getElementById("mcdExportJson"),
    searchInput: shadow.getElementById("mcdSearch"),
    statusText: shadow.getElementById("mcdStatus"),
    list: shadow.getElementById("mcdList"),
    badgeLayer: shadow.getElementById("mcdBadgeLayer")
  };

  state.elements.launcher.addEventListener("click", () => {
    togglePanel(!state.uiOpen);
  });

  state.elements.closeBtn.addEventListener("click", () => {
    togglePanel(false);
  });

  state.elements.refreshBtn.addEventListener("click", () => {
    scheduleScan(80);
    refreshPanelItems(true);
  });

  state.elements.clearBtn.addEventListener("click", async () => {
    await runtimeSendMessage({ type: "CLEAR_MEDIA_FOR_TAB" });
    state.panelItems = [];
    state.lastFilteredItems = [];
    renderPanelList();
    setStatus("已清空当前页面缓存。");
  });

  state.elements.typeFilterBtn.addEventListener("click", () => {
    const nextByCurrent = {
      all: "video",
      video: "image",
      image: "all"
    };

    state.mediaTypeFilter = nextByCurrent[state.mediaTypeFilter] || "all";
    renderPanelList();
    setStatus(`已切换类型过滤：${getMediaTypeFilterLabel(state.mediaTypeFilter)}。`);
  });

  state.elements.onlyPlayingBtn.addEventListener("click", () => {
    state.onlyPlayingOnly = !state.onlyPlayingOnly;
    renderPanelList();
    setStatus(state.onlyPlayingOnly ? "已开启仅播放中过滤。" : "已关闭仅播放中过滤。");
  });

  state.elements.batchDownloadBtn.addEventListener("click", () => {
    batchDownloadFilteredItems();
  });

  state.elements.exportTxtBtn.addEventListener("click", () => {
    exportFilteredItems("txt");
  });

  state.elements.exportCsvBtn.addEventListener("click", () => {
    exportFilteredItems("csv");
  });

  state.elements.exportJsonBtn.addEventListener("click", () => {
    exportFilteredItems("json");
  });

  state.elements.searchInput.addEventListener("input", (event) => {
    state.panelQuery = (event.target.value || "").trim().toLowerCase();
    renderPanelList();
  });

  const startPanelDrag = (event) => {
    if (!state.elements || !state.elements.panel || !state.elements.panelHead) {
      return;
    }

    if (event.button !== 0) {
      return;
    }

    const interactive = event.target && event.target.closest
      ? event.target.closest("button,input,textarea,select,a")
      : null;
    if (interactive) {
      return;
    }

    const panel = state.elements.panel;
    const rect = panel.getBoundingClientRect();
    state.panelDrag.active = true;
    state.panelDrag.pointerId = event.pointerId;
    state.panelDrag.startX = event.clientX;
    state.panelDrag.startY = event.clientY;
    state.panelDrag.startLeft = rect.left;
    state.panelDrag.startTop = rect.top;

    panel.style.left = `${rect.left}px`;
    panel.style.top = `${rect.top}px`;
    panel.style.right = "auto";
    panel.style.bottom = "auto";

    event.preventDefault();
  };

  const movePanelDrag = (event) => {
    if (!state.panelDrag.active || !state.elements || !state.elements.panel) {
      return;
    }

    if (event.pointerId !== state.panelDrag.pointerId) {
      return;
    }

    const panel = state.elements.panel;
    const deltaX = event.clientX - state.panelDrag.startX;
    const deltaY = event.clientY - state.panelDrag.startY;
    const panelWidth = panel.offsetWidth || 420;
    const panelHeight = panel.offsetHeight || 360;

    const nextLeftRaw = state.panelDrag.startLeft + deltaX;
    const nextTopRaw = state.panelDrag.startTop + deltaY;
    const nextLeft = Math.max(4, Math.min(window.innerWidth - panelWidth - 4, nextLeftRaw));
    const nextTop = Math.max(4, Math.min(window.innerHeight - panelHeight - 4, nextTopRaw));

    panel.style.left = `${nextLeft}px`;
    panel.style.top = `${nextTop}px`;
  };

  const endPanelDrag = (event) => {
    if (!state.panelDrag.active) {
      return;
    }

    if (typeof event.pointerId === "number" && event.pointerId !== state.panelDrag.pointerId) {
      return;
    }

    state.panelDrag.active = false;
    state.panelDrag.pointerId = null;
  };

  state.elements.panelHead.addEventListener("pointerdown", startPanelDrag);
  window.addEventListener("pointermove", movePanelDrag, true);
  window.addEventListener("pointerup", endPanelDrag, true);
  window.addEventListener("pointercancel", endPanelDrag, true);

  document.addEventListener("keydown", (event) => {
    const key = (event.key || "").toLowerCase();
    if (event.altKey && key === "v") {
      event.preventDefault();
      togglePanel(!state.uiOpen);
      return;
    }

    if (key === "escape" && state.uiOpen) {
      togglePanel(false);
    }
  });

  state.uiReady = true;
  updateQuickActionsState();
  renderBadges();
}

function setStatus(text) {
  if (!state.elements || !state.elements.statusText) {
    return;
  }

  state.elements.statusText.textContent = text;
}

function startPanelAutoRefresh() {
  if (!state.extensionContextAlive) {
    return;
  }

  if (state.panelRefreshInterval) {
    return;
  }

  state.panelRefreshInterval = window.setInterval(() => {
    if (!state.extensionContextAlive) {
      stopPanelAutoRefresh();
      return;
    }

    refreshPanelItems(false);
  }, PANEL_AUTO_REFRESH_MS);
}

function stopPanelAutoRefresh() {
  if (!state.panelRefreshInterval) {
    return;
  }

  clearInterval(state.panelRefreshInterval);
  state.panelRefreshInterval = null;
}

function togglePanel(open) {
  if (!state.elements || !state.elements.panel) {
    return;
  }

  state.uiOpen = Boolean(open);
  state.elements.panel.classList.toggle("open", state.uiOpen);

  if (state.uiOpen) {
    if (!state.extensionContextAlive) {
      showTopNotice("扩展上下文已失效，请刷新页面后重试。", true);
      setStatus("扩展上下文已失效，请刷新页面后重试。");
      return;
    }

    setStatus("正在刷新媒体列表...");
    refreshPanelItems(true);
    startPanelAutoRefresh();
  } else {
    stopPanelAutoRefresh();
  }
}

function getTrackedElementByDomId(domId) {
  if (!domId) {
    return null;
  }

  const saved = state.domIdToVideo.get(domId);
  if (saved && document.contains(saved)) {
    return saved;
  }

  const found = document.querySelector(`[data-mcd-dom-id="${domId}"]`);
  if (found) {
    state.domIdToVideo.set(domId, found);
    return found;
  }

  state.domIdToVideo.delete(domId);
  return null;
}

function renderFocusBox() {
  if (!state.uiReady || !state.elements || !state.elements.focusBox) {
    return;
  }

  if (state.focusOverlayRaf) {
    cancelAnimationFrame(state.focusOverlayRaf);
    state.focusOverlayRaf = null;
  }

  state.focusOverlayRaf = requestAnimationFrame(() => {
    state.focusOverlayRaf = null;

    const focusBox = state.elements.focusBox;
    if (!focusBox) {
      return;
    }

    const domId = state.highlightDomId;
    const target = domId ? getTrackedElementByDomId(domId) : null;
    if (!target) {
      focusBox.classList.remove("show");
      return;
    }

    const rect = target.getBoundingClientRect();
    if (rect.width < 8 || rect.height < 8 || rect.bottom <= 0 || rect.right <= 0 || rect.top >= window.innerHeight || rect.left >= window.innerWidth) {
      focusBox.classList.remove("show");
      return;
    }

    const pad = 8;
    const left = Math.max(0, rect.left - pad);
    const top = Math.max(0, rect.top - pad);
    const right = Math.min(window.innerWidth, rect.right + pad);
    const bottom = Math.min(window.innerHeight, rect.bottom + pad);
    const width = Math.max(0, right - left);
    const height = Math.max(0, bottom - top);

    if (width < 8 || height < 8) {
      focusBox.classList.remove("show");
      return;
    }

    focusBox.style.left = `${left}px`;
    focusBox.style.top = `${top}px`;
    focusBox.style.width = `${width}px`;
    focusBox.style.height = `${height}px`;
    focusBox.classList.add("show");
  });
}

function clearHighlightMarkers() {
  for (const focused of document.querySelectorAll('[data-mcd-dom-id][data-mcd-focused="1"]')) {
    focused.removeAttribute("data-mcd-focused");
    focused.removeAttribute("data-mcd-focus-burst");
  }
}

function scheduleHighlightClear(domId) {
  if (state.highlightClearTimer) {
    clearTimeout(state.highlightClearTimer);
    state.highlightClearTimer = null;
  }

  state.highlightClearTimer = setTimeout(() => {
    state.highlightClearTimer = null;
    if (state.highlightDomId !== domId) {
      return;
    }

    clearHighlightMarkers();
    state.highlightDomId = "";
    renderFocusBox();
    renderBadges();
  }, HIGHLIGHT_VISIBLE_MS);
}

function focusVideo(domId, scrollIntoView) {
  clearHighlightMarkers();

  if (state.focusBurstTimer) {
    clearTimeout(state.focusBurstTimer);
    state.focusBurstTimer = null;
  }

  if (state.highlightClearTimer) {
    clearTimeout(state.highlightClearTimer);
    state.highlightClearTimer = null;
  }

  if (!domId) {
    return;
  }

  const target = getTrackedElementByDomId(domId);
  if (!target) {
    setStatus("目标元素已不在当前页面中。");
    return;
  }

  state.highlightDomId = domId;
  target.setAttribute("data-mcd-focused", "1");
  target.setAttribute("data-mcd-focus-burst", "1");
  state.focusBurstTimer = setTimeout(() => {
    target.removeAttribute("data-mcd-focus-burst");
    state.focusBurstTimer = null;
  }, 900);

  scheduleHighlightClear(domId);

  if (scrollIntoView) {
    target.scrollIntoView({ behavior: "smooth", block: "center", inline: "nearest" });
    setTimeout(() => {
      renderFocusBox();
    }, 180);
  }

  renderFocusBox();
}

function selectDomId(domId, scrollIntoView = false) {
  if (!domId) {
    return;
  }

  state.selectedDomId = domId;
  focusVideo(domId, scrollIntoView);
  renderBadges();
  renderFocusBox();
  renderPanelList();
}

function scheduleBadgeRefresh(delayMs = 120) {
  if (state.scheduledBadgeTimer) {
    clearTimeout(state.scheduledBadgeTimer);
  }

  state.scheduledBadgeTimer = setTimeout(() => {
    state.scheduledBadgeTimer = null;
    renderBadges();
  }, delayMs);
}

function renderBadges() {
  if (!state.uiReady || !state.elements || !state.elements.badgeLayer) {
    return;
  }

  const layer = state.elements.badgeLayer;
  layer.innerHTML = "";

  const showAllBadges = state.uiOpen;
  const activeDomId = state.highlightDomId || state.selectedDomId;
  if (!showAllBadges && !activeDomId) {
    renderFocusBox();
    return;
  }

  const records = state.badgeRecords || [];
  for (const record of records) {
    if (!showAllBadges && record.domId !== activeDomId) {
      continue;
    }

    const target = getTrackedElementByDomId(record.domId);
    if (!target) {
      continue;
    }

    const rect = target.getBoundingClientRect();
    const visible = isVideoVisible(rect);
    if (!visible) {
      continue;
    }

    const top = Math.max(4, Math.round(rect.top + 6));
    const left = Math.max(4, Math.round(rect.left + 6));

    const button = document.createElement("button");
    button.type = "button";
    button.className = "mcd-badge";
    if (record.isPlaying) {
      button.classList.add("is-playing");
    }
    if (record.domId === activeDomId) {
      button.classList.add("is-selected");
    }

    button.textContent = record.displayLabel || record.domId.toUpperCase();
    button.title = record.label || "视频";
    button.style.left = `${left}px`;
    button.style.top = `${top}px`;
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (!state.uiOpen) {
        togglePanel(true);
      }
      selectDomId(record.domId, true);
    });

    layer.appendChild(button);
  }

  renderFocusBox();
}

function formatBytes(bytes) {
  if (!bytes || bytes <= 0) {
    return "大小未知";
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
    const compactPath = parsed.pathname.length > 54 ? `${parsed.pathname.slice(0, 54)}...` : parsed.pathname;
    return `${parsed.hostname}${compactPath}`;
  } catch {
    if (!url) {
      return "";
    }

    return url.length > 86 ? `${url.slice(0, 86)}...` : url;
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
    "audio/mp3": "mp3",
    "audio/mp4": "m4a",
    "audio/aac": "m4a",
    "audio/webm": "webm",
    "audio/ogg": "ogg",
    "audio/flac": "flac",
    "audio/x-flac": "flac",
    "audio/wav": "wav",
    "audio/x-wav": "wav",
    "audio/x-ms-wma": "wma"
  };

  return map[(mimeType || "").toLowerCase()] || "";
}

function extractExtensionFromUrl(url) {
  const matched = (url || "").match(/\.([a-z0-9]{2,5})(?:[?#]|$)/i);
  return matched ? matched[1].toLowerCase() : "";
}

function sanitizeName(name) {
  return (name || "视频")
    .replace(/[\\/:*?"<>|]+/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

function buildFileName(item, preferredUrl = "") {
  const base = sanitizeName(item.label || item.filenameHint || item.domId || "媒体") || "媒体";
  const sourceUrl = preferredUrl || item.url || item.downloadUrl || "";
  const itemType = detectItemType(item);
  const defaultExt = itemType === "audio" ? "mp3" : itemType === "image" ? "jpg" : "mp4";
  const ext = extractExtensionFromUrl(sourceUrl) || extensionFromMime(item.mimeType) || defaultExt;
  return `${base}.${ext}`;
}

function isHttpUrl(url) {
  return /^https?:/i.test(url || "");
}

function getDirectDownloadUrl(item) {
  if (!item) {
    return "";
  }

  if (isHttpUrl(item.url)) {
    return item.url;
  }

  if (isHttpUrl(item.downloadUrl)) {
    return item.downloadUrl;
  }

  return "";
}

function getVideoElementByItem(item) {
  if (!item || !item.domId) {
    return null;
  }

  const target = getTrackedElementByDomId(item.domId);
  if (!target) {
    return null;
  }

  return (target.tagName || "").toLowerCase() === "video" ? target : null;
}

function getAudioElementByItem(item) {
  if (!item || !item.domId) {
    return null;
  }

  const target = getTrackedElementByDomId(item.domId);
  if (!target) {
    return null;
  }

  return (target.tagName || "").toLowerCase() === "audio" ? target : null;
}

function stopStreamQuietly(stream) {
  if (stream && typeof stream.getTracks === "function") {
    for (const track of stream.getTracks()) {
      try {
        track.stop();
      } catch {
        // ignore track stop errors
      }
    }
  }
}

function getRecordingSession(domId) {
  if (!domId) {
    return null;
  }

  return state.recordingSessions.get(domId) || null;
}

function isRecordingActive(domId) {
  const session = getRecordingSession(domId);
  return Boolean(session && session.mediaRecorder && session.mediaRecorder.state !== "inactive");
}

function getPreferredRecordMimeType(isAudio = false) {
  if (typeof MediaRecorder === "undefined" || typeof MediaRecorder.isTypeSupported !== "function") {
    return "";
  }

  const preferred = isAudio
    ? [
        "audio/webm;codecs=opus",
        "audio/webm",
        "audio/mp4",
        "audio/ogg;codecs=opus",
        "audio/ogg"
      ]
    : [
        "video/webm;codecs=vp9,opus",
        "video/webm;codecs=vp8,opus",
        "video/webm;codecs=vp9",
        "video/webm;codecs=vp8",
        "video/webm"
      ];

  for (const mimeType of preferred) {
    try {
      if (MediaRecorder.isTypeSupported(mimeType)) {
        return mimeType;
      }
    } catch {
      // ignore type support check errors
    }
  }

  return "";
}

function buildRecordingFileName(item, mimeType = "") {
  const base = sanitizeName(item.label || item.filenameHint || item.displayLabel || item.domId || "媒体录制") || "媒体录制";
  const ext = extensionFromMime(mimeType) || "webm";
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `${base}-录制-${stamp}.${ext}`;
}

function finalizeRecordingSession(domId) {
  const session = getRecordingSession(domId);
  if (!session) {
    renderPanelList();
    return;
  }

  state.recordingSessions.delete(domId);

  if (session.stream && typeof session.stream.getTracks === "function") {
    for (const track of session.stream.getTracks()) {
      try {
        track.stop();
      } catch {
        // ignore track stop errors
      }
    }
  }

  const chunks = Array.isArray(session.chunks) ? session.chunks : [];
  if (!chunks.length) {
    setStatus("录制结束，但没有可保存的数据。请先播放一段后再试。");
    renderPanelList();
    return;
  }

  const mimeType =
    (session.mediaRecorder && session.mediaRecorder.mimeType) || session.mimeType || "video/webm";
  const blob = new Blob(chunks, { type: mimeType });
  if (!blob.size) {
    setStatus("录制结束，但文件为空。请先播放一段后再试。");
    renderPanelList();
    return;
  }

  const anchor = document.createElement("a");
  const objectUrl = URL.createObjectURL(blob);
  anchor.href = objectUrl;
  anchor.download = buildRecordingFileName(session.itemSnapshot || { domId }, mimeType);
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => {
    URL.revokeObjectURL(objectUrl);
  }, 2400);

  setStatus(`录制完成，已保存 ${formatBytes(blob.size)}。`);
  renderPanelList();
}

function startRecordingFromItem(item) {
  if (!item) {
    setStatus("没有可录制的条目。");
    return;
  }

  const itemType = detectItemType(item);
  if (itemType !== "video" && itemType !== "audio") {
    setStatus("仅视频与音频条目支持录制下载。");
    return;
  }

  const isAudio = itemType === "audio";
  const domId = item.domId || "";
  if (!domId) {
    setStatus(`该条目没有可定位的${isAudio ? "音频" : "视频"}元素，无法录制。`);
    return;
  }

  if (isRecordingActive(domId)) {
    setStatus(`该${isAudio ? "音频" : "视频"}已在录制中。点击“停止录制”可保存文件。`);
    return;
  }

  const mediaEl = isAudio ? getAudioElementByItem(item) : getVideoElementByItem(item);
  if (!mediaEl) {
    setStatus(`未找到可录制的${isAudio ? "音频" : "视频"}元素，请先定位到媒体并保持在页面中。`);
    return;
  }

  if (typeof MediaRecorder === "undefined") {
    setStatus("当前浏览器不支持 MediaRecorder，无法录制。");
    return;
  }

  const captureStream = mediaEl.captureStream || mediaEl.mozCaptureStream;
  if (typeof captureStream !== "function") {
    setStatus(`当前${isAudio ? "音频" : "视频"}不支持捕获录制。可尝试切到可下载直链后再下载。`);
    return;
  }

  let stream = null;
  try {
    stream = captureStream.call(mediaEl);
  } catch (error) {
    setStatus(`启动录制失败：${error && error.message ? error.message : "无法获取媒体流"}`);
    return;
  }

  const hasVideoTrack =
    stream && typeof stream.getVideoTracks === "function" && stream.getVideoTracks().length > 0;
  const hasAudioTrack =
    stream && typeof stream.getAudioTracks === "function" && stream.getAudioTracks().length > 0;

  if (isAudio && !hasAudioTrack) {
    stopStreamQuietly(stream);
    setStatus("未捕获到音频轨道，请先播放音频 1-2 秒后再点录制。");
    return;
  }

  if (!isAudio && !hasVideoTrack) {
    stopStreamQuietly(stream);
    setStatus("未捕获到视频轨道，请先播放视频 1-2 秒后再点录制。");
    return;
  }

  const preferredMimeType = getPreferredRecordMimeType(isAudio);

  let mediaRecorder = null;
  try {
    mediaRecorder = preferredMimeType
      ? new MediaRecorder(stream, { mimeType: preferredMimeType })
      : new MediaRecorder(stream);
  } catch (error) {
    stopStreamQuietly(stream);
    setStatus(`录制器创建失败：${error && error.message ? error.message : "当前编码不支持"}`);
    return;
  }

  const session = {
    domId,
    mediaRecorder,
    stream,
    mimeType: mediaRecorder.mimeType || preferredMimeType || (isAudio ? "audio/webm" : "video/webm"),
    chunks: [],
    itemSnapshot: {
      domId,
      label: item.label || "",
      filenameHint: item.filenameHint || "",
      displayLabel: item.displayLabel || ""
    }
  };

  state.recordingSessions.set(domId, session);

  mediaRecorder.ondataavailable = (event) => {
    if (event && event.data && event.data.size > 0) {
      session.chunks.push(event.data);
    }
  };

  mediaRecorder.onstop = () => {
    finalizeRecordingSession(domId);
  };

  mediaRecorder.onerror = (event) => {
    const message =
      (event && event.error && event.error.message) || "录制时发生错误，可尝试重新开始录制。";
    setStatus(`录制异常：${message}`);
  };

  try {
    mediaRecorder.start(1000);
  } catch (error) {
    state.recordingSessions.delete(domId);
    stopStreamQuietly(stream);
    setStatus(`录制启动失败：${error && error.message ? error.message : "未知错误"}`);
    renderPanelList();
    return;
  }

  setStatus(`开始录制${isAudio ? "音频" : "视频"}，完成后点“停止录制”即可下载文件。`);
  renderPanelList();
}

function stopRecordingByDomId(domId, notify = true) {
  const session = getRecordingSession(domId);
  if (!session) {
    if (notify) {
      setStatus("该条目当前没有正在进行的录制。");
    }
    return;
  }

  const recorder = session.mediaRecorder;
  if (!recorder || recorder.state === "inactive") {
    finalizeRecordingSession(domId);
    return;
  }

  try {
    recorder.stop();
    if (notify) {
      setStatus("正在停止录制并生成下载文件...");
    }
  } catch (error) {
    finalizeRecordingSession(domId);
    if (notify) {
      setStatus(`停止录制失败：${error && error.message ? error.message : "未知错误"}`);
    }
  }
}

function stopAllRecordingSessions() {
  for (const domId of [...state.recordingSessions.keys()]) {
    stopRecordingByDomId(domId, false);
  }
}

function attachDownloadCandidates(items) {
  if (!Array.isArray(items) || !items.length) {
    return;
  }

  const candidates = items.filter((item) => {
    if (!item || !isHttpUrl(item.url)) {
      return false;
    }

    if (detectItemType(item) !== "video") {
      return false;
    }

    return true;
  });

  if (!candidates.length) {
    return;
  }

  const usedUrls = new Set();
  const rankCandidate = (candidate, target) => {
    let score = 0;
    const tags = Array.isArray(candidate.sourceTags) ? candidate.sourceTags : [];
    const mime = (candidate.mimeType || "").toLowerCase();

    if (tags.includes("network")) {
      score += 50;
    }
    if (mime.startsWith("video/")) {
      score += 12;
    }
    if (mime.includes("mpegurl") || /\.m3u8([?#]|$)/i.test(candidate.url || "")) {
      score += 18;
    }
    if (target.label && candidate.label && target.label === candidate.label) {
      score += 8;
    }
    if (target.domId && candidate.domId && target.domId === candidate.domId) {
      score += 30;
    }

    const delta = Math.abs((candidate.lastSeen || 0) - (target.lastSeen || 0));
    if (delta <= 5000) {
      score += 12;
    } else if (delta <= 15000) {
      score += 8;
    } else if (delta <= 60000) {
      score += 4;
    }

    score += Math.min(10, Math.floor((candidate.score || 0) / 10));
    return score;
  };

  for (const item of items) {
    if (!item || !item.isPlaying) {
      continue;
    }

    if (detectItemType(item) !== "video") {
      continue;
    }

    if (isHttpUrl(item.url) || isHttpUrl(item.downloadUrl)) {
      continue;
    }

    let best = null;
    let bestScore = -1;

    for (const candidate of candidates) {
      if (usedUrls.has(candidate.url)) {
        continue;
      }

      const score = rankCandidate(candidate, item);
      if (score > bestScore) {
        bestScore = score;
        best = candidate;
      }
    }

    if (best && bestScore >= 20) {
      item.downloadUrl = best.url;
      item.downloadMimeType = best.mimeType || "";
      item.downloadResolved = true;
      usedUrls.add(best.url);
    }
  }
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

async function requestDownload(item) {
  const downloadUrl = getDirectDownloadUrl(item);
  if (!item || !downloadUrl) {
    setStatus("该条目暂无可下载链接。");
    return;
  }

  const response = await runtimeSendMessage({
    type: "DOWNLOAD_MEDIA",
    url: downloadUrl,
    filename: buildFileName(item, downloadUrl)
  });

  if (!response || !response.ok) {
    setStatus(`下载失败：${response && response.error ? response.error : "未知错误"}`);
    return;
  }

  setStatus("已加入浏览器下载队列。");
}

function mergePanelItems(remoteItems) {
  const output = Array.isArray(remoteItems) ? [...remoteItems] : [];
  const domWithUrl = new Set();

  for (const item of output) {
    if (item && item.domId) {
      domWithUrl.add(item.domId);
    }
  }

  for (const placeholder of state.placeholdersByDomId.values()) {
    if (!domWithUrl.has(placeholder.domId)) {
      output.push({
        ...placeholder,
        sourceTags: ["dom"],
        score: -1,
        lastSeen: Date.now()
      });
    }
  }

  attachDownloadCandidates(output);

  for (const item of output) {
    item.isStream = isStreamItem(item);
  }

  output.sort((a, b) => {
    const aPlaying = a.isPlaying ? 1 : 0;
    const bPlaying = b.isPlaying ? 1 : 0;
    if (bPlaying !== aPlaying) {
      return bPlaying - aPlaying;
    }

    const aVisible = a.isVisible ? 1 : 0;
    const bVisible = b.isVisible ? 1 : 0;
    if (bVisible !== aVisible) {
      return bVisible - aVisible;
    }

    if ((a.domOrder || 0) && (b.domOrder || 0) && a.domOrder !== b.domOrder) {
      return a.domOrder - b.domOrder;
    }

    if ((b.score || 0) !== (a.score || 0)) {
      return (b.score || 0) - (a.score || 0);
    }

    return (b.lastSeen || 0) - (a.lastSeen || 0);
  });

  return output;
}

function makeChip(text) {
  const chip = document.createElement("span");
  chip.className = "mcd-chip";
  chip.textContent = text;
  return chip;
}

function updateQuickActionsState() {
  if (!state.uiReady || !state.elements) {
    return;
  }

  if (state.elements.typeFilterBtn) {
    state.elements.typeFilterBtn.textContent = `类型: ${getMediaTypeFilterLabel(state.mediaTypeFilter)}`;
    state.elements.typeFilterBtn.classList.toggle("is-active", state.mediaTypeFilter !== "all");
  }

  if (state.elements.onlyPlayingBtn) {
    state.elements.onlyPlayingBtn.textContent = state.onlyPlayingOnly ? "仅播放中: 开" : "仅播放中: 关";
    state.elements.onlyPlayingBtn.classList.toggle("is-active", state.onlyPlayingOnly);
  }

  if (state.elements.batchDownloadBtn) {
    state.elements.batchDownloadBtn.disabled = state.isBatchDownloading;
    state.elements.batchDownloadBtn.textContent = state.isBatchDownloading ? "批量下载中..." : "批量下载";
  }
}

function getMediaTypeFilterLabel(filterType) {
  const map = {
    all: "全部",
    video: "仅视频",
    image: "仅图片"
  };

  return map[filterType] || "全部";
}

function detectItemType(item) {
  const tag = (item.tagName || "").toLowerCase();
  const mime = (item.mimeType || "").toLowerCase();
  const url = (item.url || "").toLowerCase();

  if (tag === "img") {
    return "image";
  }

  if (tag === "audio") {
    return "audio";
  }

  if (mime.startsWith("image/")) {
    return "image";
  }

  if (mime.startsWith("audio/")) {
    return "audio";
  }

  if (mime.startsWith("video/")) {
    return "video";
  }

  if (IMAGE_EXT_RE.test(url)) {
    return "image";
  }

  if (AUDIO_EXT_RE.test(url)) {
    return "audio";
  }

  return "video";
}

function isStreamItem(item) {
  if (!item) {
    return false;
  }

  const url = (item.url || item.downloadUrl || "").toLowerCase();
  const mime = (item.mimeType || item.downloadMimeType || "").toLowerCase();

  if (/\.(m3u8|m3u|mpd)([?#]|$)/i.test(url)) {
    return true;
  }

  if (mime.includes("mpegurl") || mime.includes("dash+xml") || mime.includes("x-mpegurl")) {
    return true;
  }

  return false;
}

function getFilteredPanelItems() {
  const q = state.panelQuery;

  return state.panelItems.filter((item) => {
    const itemType = detectItemType(item);
    if (state.mediaTypeFilter === "video" && itemType !== "video") {
      return false;
    }

    if (state.mediaTypeFilter === "image" && itemType !== "image") {
      return false;
    }

    if (state.onlyPlayingOnly && !item.isPlaying) {
      return false;
    }

    if (!q) {
      return true;
    }

    const haystack = `${item.displayLabel || ""} ${item.domId || ""} ${item.label || ""} ${item.url || ""} ${item.mimeType || ""}`.toLowerCase();
    return haystack.includes(q);
  });
}

function toCsvCell(value) {
  const text = `${value || ""}`;
  if (!/[",\n]/.test(text)) {
    return text;
  }

  return `"${text.replace(/"/g, '""')}"`;
}

function getSourceText(item) {
  const tags = Array.isArray(item.sourceTags) ? item.sourceTags : [];
  const output = [];

  if (tags.includes("dom")) {
    output.push("页面");
  }
  if (tags.includes("network")) {
    output.push("网络");
  }

  return output.length ? output.join("+") : "未知";
}

function getExportBaseName() {
  let host = "page";
  try {
    host = new URL(window.location.href).hostname || "page";
  } catch {
    host = "page";
  }

  const safeHost = host.replace(/[^a-zA-Z0-9_.-]+/g, "_");
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `media_export_${safeHost}_${stamp}`;
}

function downloadTextAsFile(fileName, content, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = objectUrl;
  anchor.download = fileName;
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => {
    URL.revokeObjectURL(objectUrl);
  }, 1000);
}

function exportFilteredItems(format) {
  const filtered = getFilteredPanelItems()
    .map((item) => ({
      ...item,
      exportUrl: getDirectDownloadUrl(item) || item.url || ""
    }))
    .filter((item) => item.exportUrl);
  if (!filtered.length) {
    setStatus("当前筛选结果没有可导出的链接。");
    return;
  }

  const baseName = getExportBaseName();
  if (format === "txt") {
    const lines = filtered.map((item) => `${item.displayLabel || ""}\t${item.label || ""}\t${item.exportUrl}`);
    downloadTextAsFile(`${baseName}.txt`, lines.join("\n"), "text/plain;charset=utf-8");
    setStatus(`已导出 TXT，共 ${filtered.length} 条。`);
    return;
  }

  if (format === "csv") {
    const header = ["编号", "标题", "链接", "类型", "时长", "分辨率", "来源", "播放中"];
    const rows = filtered.map((item) => {
      const duration = item.duration || "";
      const resolution = item.width && item.height ? `${item.width}x${item.height}` : "";
      const cells = [
        item.displayLabel || item.domId || "",
        item.label || "",
        item.exportUrl || "",
        item.mimeType || "",
        duration,
        resolution,
        getSourceText(item),
        item.isPlaying ? "是" : "否"
      ];

      return cells.map((value) => toCsvCell(value)).join(",");
    });

    const content = [header.map((value) => toCsvCell(value)).join(","), ...rows].join("\n");
    downloadTextAsFile(`${baseName}.csv`, content, "text/csv;charset=utf-8");
    setStatus(`已导出 CSV，共 ${filtered.length} 条。`);
    return;
  }

  if (format === "json") {
    const payload = filtered.map((item) => ({
      id: item.displayLabel || item.domId || "",
      title: item.label || "",
      url: item.exportUrl || "",
      mimeType: item.mimeType || "",
      duration: item.duration || 0,
      width: item.width || 0,
      height: item.height || 0,
      source: getSourceText(item),
      isPlaying: Boolean(item.isPlaying)
    }));

    downloadTextAsFile(`${baseName}.json`, JSON.stringify(payload, null, 2), "application/json;charset=utf-8");
    setStatus(`已导出 JSON，共 ${filtered.length} 条。`);
  }
}

async function batchDownloadFilteredItems() {
  if (state.isBatchDownloading) {
    return;
  }

  const filtered = getFilteredPanelItems();
  const downloadable = filtered
    .map((item) => ({
      item,
      downloadUrl: getDirectDownloadUrl(item)
    }))
    .filter((entry) => Boolean(entry.downloadUrl) && !entry.item.isStream);

  if (!downloadable.length) {
    setStatus("当前筛选结果里没有可批量下载的链接。");
    return;
  }

  state.isBatchDownloading = true;
  updateQuickActionsState();

  let successCount = 0;
  let failCount = 0;

  try {
    for (const entry of downloadable) {
      if (!state.extensionContextAlive) {
        break;
      }

      const item = entry.item;
      const downloadUrl = entry.downloadUrl;

      const result = await runtimeSendMessage({
        type: "DOWNLOAD_MEDIA",
        url: downloadUrl,
        filename: buildFileName(item, downloadUrl)
      });

      if (result && result.ok) {
        successCount += 1;
      } else {
        failCount += 1;
      }

      await new Promise((resolve) => setTimeout(resolve, 120));
    }

    setStatus(`批量下载完成：成功 ${successCount} 条，失败 ${failCount} 条。`);
  } finally {
    state.isBatchDownloading = false;
    updateQuickActionsState();
  }
}

function renderPanelList() {
  if (!state.uiReady || !state.elements || !state.elements.list) {
    return;
  }

  const list = state.elements.list;
  list.innerHTML = "";

  const filtered = getFilteredPanelItems();
  state.lastFilteredItems = filtered;
  updateQuickActionsState();

  if (!filtered.length) {
    const empty = document.createElement("li");
    empty.className = "mcd-empty";
    empty.textContent = state.panelItems.length
      ? "当前筛选条件没有匹配结果。"
      : "尚未捕获到媒体资源，请先播放视频再点击刷新。";
    list.appendChild(empty);
    return;
  }

  for (const item of filtered) {
    const li = document.createElement("li");
    li.className = "mcd-item";
    if (item.domId && item.domId === state.selectedDomId) {
      li.classList.add("is-selected");
    }

    const title = document.createElement("h3");
    title.className = "mcd-item-title";
    const titlePrefix = item.displayLabel ? `[${item.displayLabel}] ` : item.domId ? `[${item.domId.toUpperCase()}] ` : "";
    title.textContent = `${titlePrefix}${item.label || item.filenameHint || shortUrl(item.url) || "未命名媒体"}`;

    const urlNode = document.createElement("p");
    urlNode.className = "mcd-item-url";
    const directUrl = getDirectDownloadUrl(item);
    if (item.url && isHttpUrl(item.url)) {
      urlNode.textContent = shortUrl(item.url);
    } else if (directUrl) {
      urlNode.textContent = `页面源非直链，已匹配下载链接：${shortUrl(directUrl)}`;
    } else {
      urlNode.textContent = "暂未获得可下载直链（可继续播放 2-5 秒后点刷新）。";
    }

    const meta = document.createElement("p");
    meta.className = "mcd-item-meta";
    const positionText =
      item.domId && (item.rectWidth || item.rectHeight)
        ? `x:${Math.round(item.rectX || 0)}, y:${Math.round(item.rectY || 0)}, ${Math.round(item.rectWidth || 0)}x${Math.round(item.rectHeight || 0)}`
        : "位置未知";
    meta.textContent = `${formatDuration(item.duration)} | ${formatBytes(item.contentLength)} | ${positionText}`;

    const chips = document.createElement("div");
    chips.className = "mcd-chip-row";
    const itemType = detectItemType(item);
    chips.appendChild(makeChip(itemType === "image" ? "图片" : itemType === "audio" ? "音频" : "视频"));
    if (item.isPlaying) {
      chips.appendChild(makeChip("播放中"));
    }
    if (item.isVisible) {
      chips.appendChild(makeChip("可见"));
    }
    if (item.mimeType) {
      chips.appendChild(makeChip(item.mimeType));
    }
    if (item.isStream) {
      chips.appendChild(makeChip("流媒体"));
    }
    if (item.downloadResolved) {
      chips.appendChild(makeChip("已匹配直链"));
    }
    if (item.domId && isRecordingActive(item.domId)) {
      chips.appendChild(makeChip("录制中"));
    }
    const tags = Array.isArray(item.sourceTags) ? item.sourceTags : [];
    if (tags.includes("dom")) {
      chips.appendChild(makeChip("页面"));
    }
    if (tags.includes("network")) {
      chips.appendChild(makeChip("网络"));
    }

    const actions = document.createElement("div");
    actions.className = "mcd-actions";

    const locateBtn = document.createElement("button");
    locateBtn.type = "button";
    locateBtn.className = "mcd-btn mcd-ghost";
    locateBtn.textContent = "定位";
    if (!item.domId || item.inFrame) {
      locateBtn.disabled = true;
      if (item.inFrame) {
        locateBtn.title = "该媒体位于页面子框架内，无法直接定位，但可正常下载。";
      }
    }
    locateBtn.addEventListener("click", () => {
      if (item.domId && !item.inFrame) {
        selectDomId(item.domId, true);
      }
    });

    const downloadBtn = document.createElement("button");
    downloadBtn.type = "button";
    downloadBtn.className = "mcd-btn mcd-primary";
    downloadBtn.textContent = "下载";
    if (isStreamItem(item)) {
      downloadBtn.disabled = true;
      downloadBtn.title = "流媒体为分片列表，需借助专门合并工具（如 yt-dlp / ffmpeg）下载。可点“复制”拿到地址。";
    } else if (!directUrl) {
      downloadBtn.disabled = true;
      downloadBtn.title = "当前条目尚未捕获到可下载的 http/https 直链。";
    } else if (item.url && !isHttpUrl(item.url)) {
      downloadBtn.title = "该视频使用页面流地址，下载将使用自动匹配的网络直链。";
    }
    downloadBtn.addEventListener("click", () => {
      requestDownload(item);
    });

    const recordBtn = document.createElement("button");
    recordBtn.type = "button";
    recordBtn.className = "mcd-btn mcd-soft";

    const isVideoItem = itemType === "video";
    const isAudioItem = itemType === "audio";
    const mediaElement = isVideoItem
      ? getVideoElementByItem(item)
      : isAudioItem
        ? getAudioElementByItem(item)
        : null;
    const canCapture =
      Boolean(mediaElement) &&
      (typeof mediaElement.captureStream === "function" || typeof mediaElement.mozCaptureStream === "function") &&
      typeof MediaRecorder !== "undefined";
    const recordingNow = item.domId ? isRecordingActive(item.domId) : false;

    recordBtn.textContent = recordingNow ? "停止录制" : "录制下载";

    if ((!isVideoItem && !isAudioItem) || !item.domId) {
      recordBtn.disabled = true;
      recordBtn.title = "仅可定位的视频 / 音频条目支持录制下载。";
    } else if (!recordingNow && !canCapture) {
      recordBtn.disabled = true;
      recordBtn.title = `当前页面${isAudioItem ? "音频" : "视频"}不支持录制捕获。`;
    } else if (recordingNow) {
      recordBtn.classList.add("mcd-danger");
      recordBtn.title = "点击停止并保存录制文件。";
    } else {
      recordBtn.title = "没有直链时可用：直接录制当前播放内容并下载。";
    }

    recordBtn.addEventListener("click", () => {
      if (!item.domId) {
        return;
      }

      if (isRecordingActive(item.domId)) {
        stopRecordingByDomId(item.domId, true);
        return;
      }

      startRecordingFromItem(item);
    });

    const copyBtn = document.createElement("button");
    copyBtn.type = "button";
    copyBtn.className = "mcd-btn mcd-soft";
    copyBtn.textContent = "复制";
    if (!directUrl && !item.url) {
      copyBtn.disabled = true;
    }
    copyBtn.addEventListener("click", async () => {
      const ok = await copyToClipboard(directUrl || item.url || "");
      setStatus(ok ? "链接已复制。" : "复制失败。");
    });

    actions.appendChild(locateBtn);
    actions.appendChild(downloadBtn);
    actions.appendChild(recordBtn);
    actions.appendChild(copyBtn);

    li.appendChild(title);
    li.appendChild(urlNode);
    li.appendChild(meta);
    li.appendChild(chips);
    li.appendChild(actions);

    list.appendChild(li);
  }
}

async function refreshPanelItems(forceRescan) {
  if (!state.extensionContextAlive) {
    setStatus("扩展上下文已失效，请刷新页面后重试。");
    return;
  }

  if (forceRescan) {
    await runtimeSendMessage({ type: "RESCAN_TAB" });
  }

  const response = await runtimeSendMessage({ type: "GET_MEDIA_FOR_TAB" });
  if (!response || !response.ok) {
    setStatus(`读取媒体失败：${response && response.error ? response.error : "未知错误"}`);
    return;
  }

  state.panelItems = mergePanelItems(response.items || []);
  renderPanelList();
  setStatus(`已捕获 ${state.panelItems.length} 条媒体资源。`);
}

async function sendDomMedia() {
  if (!state.extensionContextAlive) {
    return;
  }

  const payload = buildPayload();
  state.placeholdersByDomId = payload.placeholdersByDomId;
  state.badgeRecords = payload.badgeRecords;
  renderBadges();

  const report = await runtimeSendMessage({
    type: "DOM_MEDIA_FOUND",
    items: payload.items,
    pageTitle: cleanText(document.title || "", 140),
    pageUrl: window.location.href
  });

  if (!report || !report.ok) {
    return;
  }

  if (state.uiOpen) {
    schedulePanelRefresh(120);
  }
}

function schedulePanelRefresh(delayMs = 160) {
  if (!state.extensionContextAlive) {
    return;
  }

  if (state.scheduledPanelRefreshTimer) {
    clearTimeout(state.scheduledPanelRefreshTimer);
  }

  state.scheduledPanelRefreshTimer = setTimeout(() => {
    state.scheduledPanelRefreshTimer = null;
    if (!state.extensionContextAlive) {
      return;
    }

    refreshPanelItems(false);
  }, delayMs);
}

function scheduleScan(delayMs = 600) {
  if (!state.extensionContextAlive) {
    return;
  }

  if (state.scheduledScanTimer) {
    clearTimeout(state.scheduledScanTimer);
  }

  state.scheduledScanTimer = setTimeout(() => {
    state.scheduledScanTimer = null;
    if (!state.extensionContextAlive) {
      return;
    }

    const now = Date.now();
    if (!state.uiOpen && !state.highlightDomId && now - state.lastScanAt < MIN_SCAN_INTERVAL_CLOSED_MS) {
      return;
    }

    state.lastScanAt = now;

    sendDomMedia();
  }, delayMs);
}

function registerRuntimeMessageListener() {
  const runtime = getRuntimeSafe();
  if (!runtime || !runtime.id || !runtime.onMessage || typeof runtime.onMessage.addListener !== "function") {
    disableExtensionBridge("扩展上下文已失效，请刷新页面后重试。");
    return;
  }

  try {
    runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (!state.extensionContextAlive) {
        sendResponse({ ok: false, error: "扩展上下文已失效。" });
        return;
      }

      if (!message || message.type !== "REQUEST_DOM_RESCAN") {
        sendResponse({ ok: false, ignored: true });
        return;
      }

      sendDomMedia()
        .then(() => {
          sendResponse({ ok: true });
        })
        .catch((error) => {
          sendResponse({
            ok: false,
            error: error && error.message ? error.message : String(error)
          });
        });

      return true;
    });
  } catch (error) {
    if (isContextInvalidError(error)) {
      disableExtensionBridge("扩展已更新，请刷新当前页面后继续使用。");
    }
  }
}

ensurePageStyle();
registerRuntimeMessageListener();
// 仅在顶层框架注入悬浮面板 UI；所有框架均参与媒体扫描与上报
if (IS_TOP_FRAME) {
  ensureUi();
}

if (document.readyState === "loading") {
  window.addEventListener("DOMContentLoaded", () => scheduleScan(120), { once: true });
} else {
  scheduleScan(80);
}

window.addEventListener("load", () => scheduleScan(140), { once: true });

const observer = new MutationObserver(() => {
  if (!state.extensionContextAlive) {
    return;
  }

  const delay = state.uiOpen || state.highlightDomId ? 900 : 1800;
  scheduleScan(delay);

  if (state.uiOpen || state.highlightDomId) {
    scheduleBadgeRefresh(240);
  }
});

state.domObserver = observer;

observer.observe(document.documentElement, {
  childList: true,
  subtree: true,
  attributes: true,
  attributeFilter: ["src", "href", "poster", "data-src", "data-original", "data-lazy-src"]
});

document.addEventListener(
  "loadedmetadata",
  (event) => {
    const target = event.target;
    if (target && target.tagName && target.tagName.toLowerCase() === "video") {
      scheduleScan(120);
    }
  },
  true
);

document.addEventListener(
  "play",
  (event) => {
    const target = event.target;
    if (target && target.tagName && target.tagName.toLowerCase() === "video") {
      scheduleScan(90);
      scheduleBadgeRefresh(90);
    }
  },
  true
);

document.addEventListener(
  "pause",
  (event) => {
    const target = event.target;
    if (target && target.tagName && target.tagName.toLowerCase() === "video") {
      scheduleScan(120);
      scheduleBadgeRefresh(90);
    }
  },
  true
);

window.addEventListener(
  "scroll",
  () => {
    scheduleBadgeRefresh(120);
  },
  true
);

window.addEventListener("resize", () => {
  scheduleBadgeRefresh(120);
});
