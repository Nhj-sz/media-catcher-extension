import { test } from "node:test";
import assert from "node:assert/strict";
import { createChromeMock, createDomMocks, loadSource } from "./mocks.mjs";

const EXPOSE = [
  "formatBytes",
  "formatDuration",
  "extractExtensionFromUrl",
  "extensionFromMime",
  "sanitizeName",
  "buildFileName",
  "shortUrl",
  "isMediaSegmentUrl",
  "isStreamUrl",
  "pickDownloadUrl"
];

function setup() {
  const { chrome } = createChromeMock();
  const dom = createDomMocks({ readyState: "loading" });
  const api = loadSource("popup.js", { chrome, window: dom.window, document: dom.document, expose: EXPOSE });
  return { api };
}

test("formatBytes / formatDuration", () => {
  const { api } = setup();
  assert.equal(api.formatBytes(0), "未知大小");
  assert.equal(api.formatBytes(1024), "1.0 KB");
  assert.equal(api.formatBytes(1024 * 1024), "1.0 MB");
  assert.equal(api.formatDuration(0), "时长未知");
  assert.equal(api.formatDuration(65), "1:05");
  assert.equal(api.formatDuration(3661), "1:01:01");
});

test("extractExtensionFromUrl / extensionFromMime", () => {
  const { api } = setup();
  assert.equal(api.extractExtensionFromUrl("https://x.com/a.MP4?x=1"), "mp4");
  assert.equal(api.extractExtensionFromUrl("https://x.com/noext"), "");
  assert.equal(api.extensionFromMime("video/webm"), "webm");
  assert.equal(api.extensionFromMime("application/vnd.apple.mpegurl"), "m3u8");
  assert.equal(api.extensionFromMime("audio/mpeg"), "mp3");
  assert.equal(api.extensionFromMime("weird/type"), "");
});

test("sanitizeName 限制长度并清理非法字符", () => {
  const { api } = setup();
  assert.equal(api.sanitizeName('a/b:c*?.mp4'), "a_b_c_.mp4");
  assert.equal(api.sanitizeName("x".repeat(200)).length, 80);
  assert.equal(api.sanitizeName(""), "媒体");
});

test("isMediaSegmentUrl / isStreamUrl 识别分片与流", () => {
  const { api } = setup();
  assert.equal(api.isMediaSegmentUrl("https://x.com/a.m4s"), true);
  assert.equal(api.isMediaSegmentUrl("https://x.com/a.mp4?range=0-1"), true);
  assert.equal(api.isMediaSegmentUrl("https://x.com/a.mp4"), false);
  assert.equal(api.isStreamUrl("https://x.com/a.m3u8"), true);
  assert.equal(api.isStreamUrl("https://x.com/a.mp4"), false);
});

test("pickDownloadUrl 跳过流媒体与分片，优先匹配直链", () => {
  const { api } = setup();
  assert.equal(
    api.pickDownloadUrl({ url: "https://x.com/a.m4s", downloadUrl: "https://x.com/v/seg-1.m4s" }),
    ""
  );
  assert.equal(api.pickDownloadUrl({ url: "https://x.com/a.m3u8" }), "");
  assert.equal(
    api.pickDownloadUrl({ url: "blob:https://x.com/x", downloadUrl: "https://x.com/full.mp4" }),
    "https://x.com/full.mp4"
  );
  assert.equal(api.pickDownloadUrl({ url: "blob:https://x.com/x" }), "");
});

test("buildFileName 组合标签与扩展名", () => {
  const { api } = setup();
  assert.equal(
    api.buildFileName({ label: "我的视频", url: "https://x.com/a.mp4" }),
    "我的视频.mp4"
  );
  assert.equal(
    api.buildFileName({ filenameHint: "clip", url: "https://x.com/b", mimeType: "video/webm" }),
    "clip.webm"
  );
  assert.equal(
    api.buildFileName({ filenameHint: "c", url: "https://x.com/c", mimeType: "application/x-mpegurl" }),
    "c.m3u8"
  );
});

test("shortUrl 截断长路径", () => {
  const { api } = setup();
  const long = "https://x.com/" + "a".repeat(120) + "/file.mp4";
  const out = api.shortUrl(long);
  assert.ok(out.startsWith("x.com/"));
  assert.ok(out.length < long.length);
  assert.equal(api.shortUrl("not a url!!"), "not a url!!");
});
