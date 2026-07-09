import { test } from "node:test";
import assert from "node:assert/strict";
import { createChromeMock, createDomMocks, loadSource } from "./mocks.mjs";

const EXPOSE = [
  "state",
  "detectItemType",
  "isStreamItem",
  "isLikelyMediaLink",
  "isLikelyImageLink",
  "cleanText",
  "normalizeDomUrl",
  "extractExtensionFromUrl",
  "buildFileName",
  "getDirectDownloadUrl",
  "getSourceText",
  "toCsvCell",
  "mergePanelItems",
  "getFilteredPanelItems",
  "attachDownloadCandidates",
  "formatBytes",
  "formatDuration",
  "shortUrl",
  "getMediaTypeFilterLabel",
  "buildPayload",
  "collectFromAudio",
  "isHttpUrl",
  "extensionFromMime",
  "getPreferredRecordMimeType",
  "startRecordingFromItem",
  "isMediaSegmentUrl",
  "getDirectDownloadUrl"
];

function setup(selectors = {}) {
  const { chrome } = createChromeMock();
  const dom = createDomMocks({ topFrame: false, readyState: "loading", selectors });
  const api = loadSource("content.js", { chrome, window: dom.window, document: dom.document, expose: EXPOSE });
  return { api, dom };
}

test("detectItemType 正确区分 图片/音频/视频", () => {
  const { api } = setup();
  assert.equal(api.detectItemType({ tagName: "img" }), "image");
  assert.equal(api.detectItemType({ tagName: "audio", url: "https://x.com/s.mp3" }), "audio");
  assert.equal(api.detectItemType({ mimeType: "audio/mpeg" }), "audio");
  assert.equal(api.detectItemType({ mimeType: "video/mp4" }), "video");
  assert.equal(api.detectItemType({ url: "https://x.com/p.jpg" }), "image");
  assert.equal(api.detectItemType({ url: "https://x.com/s.mp3" }), "audio");
  assert.equal(api.detectItemType({ url: "https://x.com/v.mp4" }), "video");
});

test("isStreamItem 识别 m3u8 / mpd 分片流", () => {
  const { api } = setup();
  assert.equal(api.isStreamItem({ url: "https://x.com/a.m3u8" }), true);
  assert.equal(api.isStreamItem({ url: "https://x.com/a.mpd" }), true);
  assert.equal(api.isStreamItem({ mimeType: "application/vnd.apple.mpegurl" }), true);
  assert.equal(api.isStreamItem({ url: "https://x.com/a.mp4" }), false);
});

test("collectFromAudio 扫描音频元素并产出 audio 条目", () => {
  const { api, dom } = setup();
  const audio = dom.makeElement("audio");
  audio.currentSrc = "https://x.com/song.mp3";
  audio.paused = false;
  audio.ended = false;
  const res = api.collectFromAudio(audio, 1);
  assert.ok(res && res.items.length === 1);
  assert.equal(res.items[0].tagName, "audio");
  assert.equal(res.items[0].url, "https://x.com/song.mp3");
  assert.equal(res.items[0].inFrame, true);
  // 无直链的音频播放器应被忽略（不产生占位噪音）
  const empty = dom.makeElement("audio");
  assert.equal(api.collectFromAudio(empty, 2), null);
});

test("mergePanelItems 标注流媒体并按播放/可见排序", () => {
  const { api } = setup();
  const items = api.mergePanelItems([
    { url: "https://x.com/a.mp4", mimeType: "video/mp4", isPlaying: false, isVisible: true, sourceTags: ["network"], domId: "v1", lastSeen: 100 },
    { url: "https://x.com/c.m3u8", sourceTags: ["network"], domId: "v9", lastSeen: 300 },
    { url: "https://x.com/b.mp4", mimeType: "video/mp4", isPlaying: true, isVisible: true, sourceTags: ["dom"], domId: "v2", lastSeen: 200 }
  ]);
  assert.equal(items.find((i) => i.url.includes("c.m3u8")).isStream, true);
  assert.equal(items.find((i) => i.url.includes("a.mp4")).isStream, false);
  assert.equal(items[0].isPlaying, true, "播放中的条目应排在最前");
});

test("attachDownloadCandidates 为 blob 播放条目匹配网络直链", () => {
  const { api } = setup();
  const items = [
    { url: "blob:https://x.com/x", domId: "v1", isPlaying: true, tagName: "video", sourceTags: ["dom"], lastSeen: 1000 },
    { url: "https://x.com/real.mp4", mimeType: "video/mp4", sourceTags: ["network"], lastSeen: 1000, score: 50 }
  ];
  api.attachDownloadCandidates(items);
  assert.equal(items[0].downloadUrl, "https://x.com/real.mp4");
  assert.equal(items[0].downloadResolved, true);
});

test("getFilteredPanelItems 支持类型/播放中/关键词过滤", () => {
  const { api } = setup();
  api.state.panelItems = [
    { url: "a.mp4", mimeType: "video/mp4", isPlaying: true, domId: "v1", sourceTags: ["dom"], label: "Clip A" },
    { url: "b.jpg", mimeType: "image/jpeg", domId: "i1", sourceTags: ["dom"], label: "Pic B" },
    { url: "c.mp3", mimeType: "audio/mpeg", domId: "a1", sourceTags: ["dom"], label: "Song C" }
  ];

  api.state.mediaTypeFilter = "image";
  let f = api.getFilteredPanelItems();
  assert.equal(f.length, 1);
  assert.equal(f[0].url, "b.jpg");

  api.state.mediaTypeFilter = "all";
  api.state.onlyPlayingOnly = true;
  f = api.getFilteredPanelItems();
  assert.equal(f.length, 1);
  assert.equal(f[0].isPlaying, true);

  api.state.onlyPlayingOnly = false;
  api.state.panelQuery = "song";
  f = api.getFilteredPanelItems();
  assert.equal(f.length, 1);
  assert.equal(f[0].url, "c.mp3");
});

test("getDirectDownloadUrl 优先直链，回退 downloadUrl", () => {
  const { api } = setup();
  assert.equal(api.getDirectDownloadUrl({ url: "https://x.com/a.mp4" }), "https://x.com/a.mp4");
  assert.equal(api.getDirectDownloadUrl({ url: "blob:x", downloadUrl: "https://x.com/b.mp4" }), "https://x.com/b.mp4");
  assert.equal(api.getDirectDownloadUrl({ url: "blob:x" }), "");
});

test("buildPayload 集成：捕获页面 <video> 元素", () => {
  const tmp = createDomMocks({ topFrame: false });
  const video = tmp.makeElement("video");
  video.currentSrc = "https://x.com/a.mp4";
  video.paused = false;
  video.ended = false;
  video.currentTime = 5;
  video.duration = 120;
  video.videoWidth = 1280;
  video.videoHeight = 720;
  video.getBoundingClientRect = () => ({ left: 10, top: 20, right: 330, bottom: 200, width: 320, height: 180 });

  const { chrome } = createChromeMock();
  const dom = createDomMocks({ topFrame: false, readyState: "loading", selectors: { video: [video] } });
  const api = loadSource("content.js", { chrome, window: dom.window, document: dom.document, expose: EXPOSE });

  const payload = api.buildPayload();
  assert.equal(payload.items.length, 1);
  const item = payload.items[0];
  assert.equal(item.url, "https://x.com/a.mp4");
  assert.equal(item.tagName, "video");
  assert.equal(item.inFrame, true);
  assert.equal(item.isPlaying, true);
  assert.equal(item.isVisible, true);
  assert.ok(item.displayLabel.startsWith("V"));
});

test("纯函数：formatBytes / formatDuration / extractExtensionFromUrl / toCsvCell", () => {
  const { api } = setup();
  assert.equal(api.formatBytes(0), "大小未知");
  assert.equal(api.formatBytes(1024), "1.0 KB");
  assert.equal(api.formatDuration(0), "时长未知");
  assert.equal(api.formatDuration(125), "2:05");
  assert.equal(api.extractExtensionFromUrl("https://x.com/a.MP4?x=1"), "mp4");
  assert.equal(api.toCsvCell('a,"b"'), '"a,""b"""');
});

test("extensionFromMime 覆盖常见音频格式", () => {
  const { api } = setup();
  assert.equal(api.extensionFromMime("audio/webm"), "webm");
  assert.equal(api.extensionFromMime("audio/ogg"), "ogg");
  assert.equal(api.extensionFromMime("audio/flac"), "flac");
  assert.equal(api.extensionFromMime("audio/wav"), "wav");
  assert.equal(api.extensionFromMime("audio/aac"), "m4a");
  assert.equal(api.extensionFromMime("audio/mpeg"), "mp3");
});

test("buildFileName 按媒体类型给默认扩展名（避免音频被命名 .mp4）", () => {
  const { api } = setup();
  // 音频元素条目：无扩展名 / 无 mime → 默认 mp3
  assert.equal(api.buildFileName({ tagName: "audio", url: "https://x.com/song", mimeType: "" }), "媒体.mp3");
  // 图片：无扩展名 / mime=image/png → 默认 jpg
  assert.equal(api.buildFileName({ url: "https://x.com/pic", mimeType: "image/png" }), "媒体.jpg");
  // 视频：无扩展名 → 默认 mp4
  assert.equal(api.buildFileName({ url: "https://x.com/clip", mimeType: "video/mp4" }), "媒体.mp4");
  // URL 自带扩展名时优先使用
  assert.equal(api.buildFileName({ url: "https://x.com/a.m4a" }), "媒体.m4a");
});

function makeMediaRecorderMock() {
  const supported = new Set([
    "audio/mp4",
    "audio/mpeg",
    "audio/webm;codecs=opus",
    "audio/webm",
    "video/mp4;codecs=h264,aac",
    "video/mp4",
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm;codecs=vp9",
    "video/webm;codecs=vp8",
    "video/webm"
  ]);

  class FakeMediaRecorder {
    constructor(stream, opts) {
      this.stream = stream;
      this.mimeType = (opts && opts.mimeType) || "";
      this.state = "inactive";
      this.ondataavailable = null;
      this.onstop = null;
      this.onerror = null;
    }

    start() {
      this.state = "recording";
    }

    stop() {
      this.state = "inactive";
      if (typeof this.onstop === "function") {
        this.onstop();
      }
    }
  }

  FakeMediaRecorder.isTypeSupported = (type) => supported.has(type);
  return FakeMediaRecorder;
}

function setupWithMediaRecorder() {
  const { chrome } = createChromeMock();
  const dom = createDomMocks({ topFrame: false, readyState: "loading" });
  const api = loadSource("content.js", {
    chrome,
    window: dom.window,
    document: dom.document,
    expose: EXPOSE,
    extraGlobals: { MediaRecorder: makeMediaRecorderMock() }
  });
  return { api, dom };
}

test("getPreferredRecordMimeType 优先 mp4（录制产物为 mp4/m4a/mp3）", () => {
  const { api } = setupWithMediaRecorder();
  assert.equal(api.getPreferredRecordMimeType(true), "audio/mp4");
  assert.equal(api.getPreferredRecordMimeType(false), "video/mp4;codecs=h264,aac");
});

test("isMediaSegmentUrl 识别 MSE/HLS/DASH 分片地址", () => {
  const { api } = setup();
  assert.equal(api.isMediaSegmentUrl("https://x.com/a.m4s"), true);
  assert.equal(api.isMediaSegmentUrl("https://x.com/v/seg-3.m4s?t=1"), true);
  assert.equal(api.isMediaSegmentUrl("https://x.com/init.mp4"), true);
  assert.equal(api.isMediaSegmentUrl("https://x.com/a.mp4?range=0-1000"), true);
  assert.equal(api.isMediaSegmentUrl("https://x.com/dash/sq/123/seg-2"), true);
  assert.equal(api.isMediaSegmentUrl("https://x.com/a.mp4"), false);
  assert.equal(api.isMediaSegmentUrl("https://x.com/a.mp3"), false);
  assert.equal(api.isMediaSegmentUrl("https://x.com/a.m3u8"), false);
});

test("getDirectDownloadUrl 跳过流媒体与分片，优先匹配直链", () => {
  const { api } = setup();
  // 分片不应作为直链
  assert.equal(
    api.getDirectDownloadUrl({ url: "https://x.com/a.m4s", downloadUrl: "https://x.com/v/seg-1.m4s" }),
    ""
  );
  // 流媒体不应作为直链
  assert.equal(
    api.getDirectDownloadUrl({ url: "https://x.com/a.m3u8" }),
    ""
  );
  // 完整文件优先 downloadUrl
  assert.equal(
    api.getDirectDownloadUrl({ url: "blob:https://x.com/x", downloadUrl: "https://x.com/full.mp4" }),
    "https://x.com/full.mp4"
  );
  // 无直链返回空
  assert.equal(
    api.getDirectDownloadUrl({ url: "blob:https://x.com/x" }),
    ""
  );
});

test("startRecordingFromItem 拒绝非音视频条目且不创建录制会话", () => {
  const { api } = setupWithMediaRecorder();
  assert.doesNotThrow(() => api.startRecordingFromItem({ tagName: "img", url: "https://x.com/p.jpg" }));
  assert.doesNotThrow(() => api.startRecordingFromItem({ tagName: "audio", domId: "" }));
  assert.equal(api.state.recordingSessions.size, 0);
});

test("mergePanelItems 为分片流条目标记 isStream（驱动面板禁用与 chip）", () => {
  const { api } = setup();
  const out = api.mergePanelItems([
    { url: "https://x.com/a.m3u8", tagName: "video" },
    { url: "https://x.com/b.mp4", tagName: "video" }
  ]);
  const stream = out.find((i) => i.url.includes("a.m3u8"));
  const plain = out.find((i) => i.url.includes("b.mp4"));
  assert.equal(stream.isStream, true);
  assert.equal(plain.isStream, false);
});

