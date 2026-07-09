import { test } from "node:test";
import assert from "node:assert/strict";
import "../bilibili_api.js";

const B = globalThis.MCD_BILI;

test("md5 向量正确", () => {
  assert.equal(B.md5("abc"), "900150983cd24fb0d6963f7d28e17f72");
  assert.equal(B.md5(""), "d41d8cd98f00b204e9800998ecf8427e");
  assert.equal(
    B.md5("message digest"),
    "f96b697d7cb7938d525a2f31aaf161d0"
  );
});

test("getMixinKey 长度为 32", () => {
  const key = B.getMixinKey("imgkeyexample0000000000000000" + "subkeyexample0000000000000000");
  assert.equal(key.length, 32);
});

test("encWbi 生成 wts 与 w_rid 且 w_rid 为 32 位十六进制", () => {
  const q = B.encWbi(
    { foo: "114", bar: "514", baz: 1919810 },
    "7cd084941338484aae1ad9425b84077c",
    "4932ca9dc3418ebddf9d3f06a12f2f5f"
  );
  assert.match(q, /(^|&)wts=\d+/);
  assert.match(q, /(^|&)w_rid=[0-9a-f]{32}$/);
  // 参数按 key 升序：bar < baz < foo < wts，w_rid 在末尾追加
  const order = q.split("&").map((p) => p.split("=")[0]);
  assert.deepEqual(order, ["bar", "baz", "foo", "wts", "w_rid"]);
});

test("encWbi 过滤特殊字符 ! ' ( ) *", () => {
  const q = B.encWbi(
    { a: "x!'()*y" },
    "7cd084941338484aae1ad9425b84077c",
    "4932ca9dc3418ebddf9d3f06a12f2f5f"
  );
  // 过滤后不应在签名的原始参数里出现这些字符
  assert.ok(!/[!'()*]/.test(q.split("&w_rid")[0]));
});

test("parsePlayUrl 解析 muxed MP4（durl）", () => {
  const json = {
    code: 0,
    data: {
      quality: 80,
      durl: [
        {
          url: "https://x.pd.bilibili.com/1.m4s?a=1",
          backup_url: ["https://y/1.m4s"],
          size: 12345
        }
      ]
    }
  };
  const r = B.parsePlayUrl(json, "mp4");
  assert.equal(r.ok, true);
  assert.equal(r.type, "mp4");
  assert.equal(r.streams.length, 1);
  const s = r.streams[0];
  assert.equal(s.kind, "mp4");
  assert.equal(s.url, "https://x.pd.bilibili.com/1.m4s?a=1");
  assert.deepEqual(s.backupUrls, ["https://y/1.m4s"]);
  assert.equal(s.qualityLabel, "1080P");
});

test("parsePlayUrl 解析 DASH 返回所有可用视频清晰度", () => {
  const json = {
    code: 0,
    data: {
      dash: {
        duration: 100,
        video: [
          { id: 64, baseUrl: "https://v/720.m4s", backupUrl: [], bandwidth: 1500, width: 1280, height: 720 },
          { id: 80, baseUrl: "https://v/1080.m4s", backupUrl: [], bandwidth: 3000, width: 1920, height: 1080 },
          { id: 32, baseUrl: "https://v/480.m4s", backupUrl: [], bandwidth: 800, width: 852, height: 480 }
        ],
        audio: [{ id: 30280, baseUrl: "https://a/3.m4s", backupUrl: [], bandwidth: 200 }]
      }
    }
  };
  const r = B.parsePlayUrl(json, "dash");
  assert.equal(r.ok, true);
  assert.equal(r.type, "dash");
  assert.equal(r.streams.length, 3);
  // 按清晰度从高到低排序
  assert.equal(r.streams[0].quality, 80);
  assert.equal(r.streams[0].qualityLabel, "1080P");
  assert.equal(r.streams[0].videoUrl, "https://v/1080.m4s");
  assert.equal(r.streams[0].audioUrl, "https://a/3.m4s");
  assert.equal(r.streams[1].quality, 64);
  assert.equal(r.streams[2].quality, 32);
});

test("parsePlayUrl 接口报错时返回 ok=false", () => {
  const r = B.parsePlayUrl({ code: -412, message: "请求被拦截" }, "mp4");
  assert.equal(r.ok, false);
  assert.equal(r.streams.length, 0);
});

test("qnLabel 映射清晰度", () => {
  assert.equal(B.qnLabel(127), "8K");
  assert.equal(B.qnLabel(80), "1080P");
  assert.equal(B.qnLabel(99999), "清晰度99999");
});

test("resolveBilibili 在 cid 缺失时自动用 getView 补 cid", async () => {
  // 伪造 fetch：第一次 getView 返回 cid，后续 playurl 返回 durl
  const origFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push(String(url));
    if (String(url).includes("/x/web-interface/nav")) {
      return {
        ok: true,
        json: async () => ({
          code: 0,
          data: {
            wbi_img: {
              img_url: "https://i0.hdslb.com/bfs/wbi/img/abcdef.png",
              sub_url: "https://i0.hdslb.com/bfs/wbi/img/123456.png"
            }
          }
        })
      };
    }
    if (String(url).includes("/x/web-interface/view")) {
      return {
        ok: true,
        json: async () => ({ code: 0, data: { cid: 123456, title: "测试视频", aid: 1 } })
      };
    }
    if (String(url).includes("/x/player/wbi/playurl")) {
      return {
        ok: true,
        json: async () => ({
          code: 0,
          data: {
            quality: 80,
            durl: [{ url: "https://x/1.mp4", backup_url: [], size: 100 }]
          }
        })
      };
    }
    return { ok: false, json: async () => ({}) };
  };

  try {
    const r = await B.resolveBilibili({ bvid: "BV1xx", cid: 0, cookie: "" });
    assert.equal(r.ok, true);
    assert.equal(r.streams.length, 1);
    assert.equal(r.streams[0].url, "https://x/1.mp4");
    assert.ok(calls.some((c) => c.includes("/x/web-interface/view")));
  } finally {
    globalThis.fetch = origFetch;
  }
});
