import { test } from "node:test";
import assert from "node:assert/strict";
import { createChromeMock, loadSource } from "./mocks.mjs";

const EXPOSE = [
  "TAB_DATA",
  "normalizeUrl",
  "isLikelyMediaUrl",
  "guessFilenameFromUrl",
  "sanitizeFilename",
  "safeText",
  "toInt",
  "toNumber",
  "getHeader",
  "scoreItem",
  "mergeMediaForTab",
  "addNetworkMedia",
  "addDomMedia",
  "clearTabData",
  "persistNow",
  "loadPersisted",
  "serializeBucket",
  "deserializeBucket"
];

function setup() {
  const m = createChromeMock();
  const api = loadSource("background.js", { chrome: m.chrome, expose: EXPOSE });
  return { ...m, api };
}

test("normalizeUrl 去掉 hash 并归一化", () => {
  const { api } = setup();
  assert.equal(api.normalizeUrl("https://x.com/a.mp4#t=10"), "https://x.com/a.mp4");
  assert.equal(api.normalizeUrl("https://x.com/a.mp4?b=1"), "https://x.com/a.mp4?b=1");
  assert.equal(api.normalizeUrl("blob:https://x.com/abc"), "blob:https://x.com/abc");
  assert.equal(api.normalizeUrl(""), "");
});

test("isLikelyMediaUrl 按 mime / 后缀 / query 判定", () => {
  const { api } = setup();
  assert.equal(api.isLikelyMediaUrl("https://x.com/a.mp4", "video/mp4"), true);
  assert.equal(api.isLikelyMediaUrl("https://x.com/a.m3u8", ""), true);
  assert.equal(api.isLikelyMediaUrl("https://x.com/a.mp4?type=video", ""), true);
  assert.equal(api.isLikelyMediaUrl("https://x.com/index.html", "text/html"), false);
});

test("guessFilenameFromUrl / sanitizeFilename", () => {
  const { api } = setup();
  assert.equal(api.guessFilenameFromUrl("https://x.com/path/clip.mp4?a=1"), "clip.mp4");
  assert.equal(api.sanitizeFilename("非法/名称*:?.mp4"), "非法_名称_.mp4");
  assert.equal(api.sanitizeFilename("a".repeat(300)).length, 180);
});

test("getHeader 大小写不敏感查找响应头", () => {
  const { api } = setup();
  const headers = [{ name: "Content-Type", value: "video/mp4" }, { name: "content-length", value: "1024" }];
  assert.equal(api.getHeader(headers, "content-type"), "video/mp4");
  assert.equal(api.getHeader(headers, "CONTENT-LENGTH"), "1024");
  assert.equal(api.getHeader([], "x"), "");
});

test("scoreItem 播放中 + dom + video 权重更高", () => {
  const { api } = setup();
  const base = { sourceTags: [], url: "u", mimeType: "" };
  const plain = api.scoreItem(base);
  const rich = api.scoreItem({
    ...base,
    sourceTags: ["dom", "network"],
    mimeType: "video/mp4",
    isPlaying: true,
    isVisible: true,
    domId: "v1",
    label: "x"
  });
  assert.ok(rich > plain + 100, "富媒体得分应显著高于基础条目");
});

test("DOM_MEDIA_FOUND → GET_MEDIA_FOR_TAB 往返合并正确", () => {
  const { api, listeners } = setup();
  let captured = {};
  const sendResponse = (r) => { captured = r; };

  listeners.onMessage(
    {
      type: "DOM_MEDIA_FOUND",
      items: [
        {
          url: "https://x.com/a.mp4",
          tagName: "video",
          mimeType: "video/mp4",
          domId: "v1",
          isPlaying: true,
          inFrame: false
        }
      ],
      pageTitle: "测试页",
      pageUrl: "https://x.com"
    },
    { tab: { id: 7 } },
    sendResponse
  );
  assert.equal(captured.ok, true);

  let getResp = {};
  listeners.onMessage({ type: "GET_MEDIA_FOR_TAB", tabId: 7 }, { tab: { id: 7 } }, (r) => { getResp = r; });

  assert.equal(getResp.ok, true);
  assert.equal(getResp.items.length, 1);
  const item = getResp.items[0];
  assert.equal(item.url, "https://x.com/a.mp4");
  assert.equal(item.tagName, "video");
  assert.equal(item.inFrame, false);
  assert.ok(item.sourceTags.includes("dom"));
  assert.ok(item.score > 0);
});

test("iframe 条目 inFrame 标记被保留", () => {
  const { api, listeners } = setup();
  listeners.onMessage(
    {
      type: "DOM_MEDIA_FOUND",
      items: [{ url: "https://x.com/inner.mp4", tagName: "video", domId: "v2", inFrame: true }]
    },
    { tab: { id: 9 } },
    () => {}
  );
  let getResp = {};
  listeners.onMessage({ type: "GET_MEDIA_FOR_TAB", tabId: 9 }, { tab: { id: 9 } }, (r) => { getResp = r; });
  assert.equal(getResp.items[0].inFrame, true);
});

test("DOWNLOAD_MEDIA 拒绝非 http/blob 链接", () => {
  const { listeners } = setup();
  let resp = {};
  listeners.onMessage({ type: "DOWNLOAD_MEDIA", url: "blob:https://x.com/abc" }, { tab: { id: 1 } }, (r) => { resp = r; });
  assert.equal(resp.ok, false);
  assert.match(resp.error, /http/i);

  let resp2 = {};
  listeners.onMessage({ type: "DOWNLOAD_MEDIA", url: "https://x.com/a.mp4", filename: "a.mp4" }, { tab: { id: 1 } }, (r) => { resp2 = r; });
  assert.equal(resp2.ok, true);
  assert.equal(resp2.downloadId, 1);
});

test("CLEAR_MEDIA_FOR_TAB 清空对应标签页数据", () => {
  const { api, listeners } = setup();
  listeners.onMessage({ type: "DOM_MEDIA_FOUND", items: [{ url: "https://x.com/a.mp4", domId: "v1" }] }, { tab: { id: 3 } }, () => {});
  assert.ok(api.TAB_DATA.has(3));
  listeners.onMessage({ type: "CLEAR_MEDIA_FOR_TAB", tabId: 3 }, { tab: { id: 3 } }, () => {});
  assert.ok(!api.TAB_DATA.has(3));
});

test("持久化：persistNow → 清空 → loadPersisted 恢复", async () => {
  const { api, sessionStore } = setup();
  api.TAB_DATA.clear();
  api.addDomMedia(5, {
    items: [{ url: "https://x.com/a.mp4", tagName: "video", mimeType: "video/mp4", domId: "v1" }],
    pageTitle: "P", pageUrl: "https://x.com"
  });

  await api.persistNow();
  assert.ok(sessionStore["MCD_TAB_DATA_V1"], "会话存储应写入 TAB_DATA");
  assert.ok(sessionStore["MCD_TAB_DATA_V1"]["5"], "应包含 tab 5");

  api.TAB_DATA.clear();
  assert.ok(!api.TAB_DATA.has(5));

  await api.loadPersisted();
  assert.ok(api.TAB_DATA.has(5), "恢复后应重新拥有 tab 5");
  const restored = api.mergeMediaForTab(5);
  assert.equal(restored.length, 1);
  assert.equal(restored[0].url, "https://x.com/a.mp4");
});

test("serializeBucket / deserializeBucket 往返一致", () => {
  const { api } = setup();
  const bucket = {
    network: new Map([["https://x.com/a.mp4", { url: "https://x.com/a.mp4", mimeType: "video/mp4" }]]),
    dom: new Map([["v1::https://x.com/a.mp4", { url: "https://x.com/a.mp4", domId: "v1" }]]),
    pageTitle: "P",
    pageUrl: "https://x.com",
    updatedAt: 12345
  };
  const round = api.deserializeBucket(api.serializeBucket(bucket));
  assert.equal(round.network.size, 1);
  assert.equal(round.dom.size, 1);
  assert.equal(round.pageTitle, "P");
  assert.equal(round.updatedAt, 12345);
});
