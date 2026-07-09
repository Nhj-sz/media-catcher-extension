/*
 * bilibili_api.js — B 站取流客户端（纯 JS，无 chrome 依赖）
 *
 * 设计目标：
 *  - 在 background service worker 中通过 importScripts 引入；
 *  - 同时可在 node 下 require 进行单元测试（不引用任何浏览器专属 API）。
 *
 * 关键流程：
 *  1. 从 window.__INITIAL_STATE__ 拿到 bvid + cid（由 content.js 负责提取并传入）。
 *  2. 调 x/web-interface/nav 取 WBI 的 img_key / sub_key。
 *  3. 对 x/player/wbi/playurl 的参数做 WBI 签名（w_rid）。
 *  4. 解析返回：优先返回「音视频合一」的 MP4 直链（data.durl），
 *     没有再退回 DASH（video / audio 分开的 baseUrl）。
 *
 * 注意：本文件不负责真正下载字节，也不负责注入 Referer —— 那是 background 的职责。
 */
(function () {
  "use strict";

  const UA =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

  // ---------------------------------------------------------------------------
  // MD5（RFC 1321）紧凑实现，仅用于 WBI 签名，不追求极致性能。
  // ---------------------------------------------------------------------------
  function md5(input) {
    function toUtf8(str) {
      const out = [];
      for (let i = 0; i < str.length; i++) {
        let c = str.charCodeAt(i);
        if (c < 0x80) {
          out.push(c);
        } else if (c < 0x800) {
          out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
        } else if (c < 0xd800 || c >= 0xe000) {
          out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
        } else {
          i++;
          c = 0x10000 + (((c & 0x3ff) << 10) | (str.charCodeAt(i) & 0x3ff));
          out.push(
            0xf0 | (c >> 18),
            0x80 | ((c >> 12) & 0x3f),
            0x80 | ((c >> 6) & 0x3f),
            0x80 | (c & 0x3f)
          );
        }
      }
      return out;
    }

    function add32(a, b) {
      return (a + b) & 0xffffffff;
    }

    function cmn(q, a, b, x, s, t) {
      a = add32(add32(a, q), add32(x, t));
      return add32((a << s) | (a >>> (32 - s)), b);
    }

    function ff(a, b, c, d, x, s, t) {
      return cmn((b & c) | (~b & d), a, b, x, s, t);
    }
    function gg(a, b, c, d, x, s, t) {
      return cmn((b & d) | (c & ~d), a, b, x, s, t);
    }
    function hh(a, b, c, d, x, s, t) {
      return cmn(b ^ c ^ d, a, b, x, s, t);
    }
    function ii(a, b, c, d, x, s, t) {
      return cmn(c ^ (b | ~d), a, b, x, s, t);
    }

    function body(x, len) {
      x[len >> 2] |= 0x80 << (8 * (len % 4));
      x[(((len + 8) >> 6) << 4) + 14] = len * 8;
      let a = 1732584193;
      let b = -271733879;
      let c = -1732584194;
      let d = 271733878;

      for (let i = 0; i < x.length; i += 16) {
        const oa = a;
        const ob = b;
        const oc = c;
        const od = d;
        a = ff(a, b, c, d, x[i], 7, -680876936);
        d = ff(d, a, b, c, x[i + 1], 12, -389564586);
        c = ff(c, d, a, b, x[i + 2], 17, 606105819);
        b = ff(b, c, d, a, x[i + 3], 22, -1044525330);
        a = ff(a, b, c, d, x[i + 4], 7, -176418897);
        d = ff(d, a, b, c, x[i + 5], 12, 1200080426);
        c = ff(c, d, a, b, x[i + 6], 17, -1473231341);
        b = ff(b, c, d, a, x[i + 7], 22, -45705983);
        a = ff(a, b, c, d, x[i + 8], 7, 1770035416);
        d = ff(d, a, b, c, x[i + 9], 12, -1958414417);
        c = ff(c, d, a, b, x[i + 10], 17, -42063);
        b = ff(b, c, d, a, x[i + 11], 22, -1990404162);
        a = ff(a, b, c, d, x[i + 12], 7, 1804603682);
        d = ff(d, a, b, c, x[i + 13], 12, -40341101);
        c = ff(c, d, a, b, x[i + 14], 17, -1502002290);
        b = ff(b, c, d, a, x[i + 15], 22, 1236535329);

        a = gg(a, b, c, d, x[i + 1], 5, -165796510);
        d = gg(d, a, b, c, x[i + 6], 9, -1069501632);
        c = gg(c, d, a, b, x[i + 11], 14, 643717713);
        b = gg(b, c, d, a, x[i], 20, -373897302);
        a = gg(a, b, c, d, x[i + 5], 5, -701558691);
        d = gg(d, a, b, c, x[i + 10], 9, 38016083);
        c = gg(c, d, a, b, x[i + 15], 14, -660478335);
        b = gg(b, c, d, a, x[i + 4], 20, -405537848);
        a = gg(a, b, c, d, x[i + 9], 5, 568446438);
        d = gg(d, a, b, c, x[i + 14], 9, -1019803690);
        c = gg(c, d, a, b, x[i + 3], 14, -187363961);
        b = gg(b, c, d, a, x[i + 8], 20, 1163531501);
        a = gg(a, b, c, d, x[i + 13], 5, -1444681467);
        d = gg(d, a, b, c, x[i + 2], 9, -51403784);
        c = gg(c, d, a, b, x[i + 7], 14, 1735328473);
        b = gg(b, c, d, a, x[i + 12], 20, -1926607734);

        a = hh(a, b, c, d, x[i + 5], 4, -378558);
        d = hh(d, a, b, c, x[i + 8], 11, -2022574463);
        c = hh(c, d, a, b, x[i + 11], 16, 1839030562);
        b = hh(b, c, d, a, x[i + 14], 23, -35309556);
        a = hh(a, b, c, d, x[i + 1], 4, -1530992060);
        d = hh(d, a, b, c, x[i + 4], 11, 1272893353);
        c = hh(c, d, a, b, x[i + 7], 16, -155497632);
        b = hh(b, c, d, a, x[i + 10], 23, -1094730640);
        a = hh(a, b, c, d, x[i + 13], 4, 681279174);
        d = hh(d, a, b, c, x[i + 0], 11, -358537222);
        c = hh(c, d, a, b, x[i + 3], 16, -722521979);
        b = hh(b, c, d, a, x[i + 6], 23, 76029189);
        a = hh(a, b, c, d, x[i + 9], 4, -640364487);
        d = hh(d, a, b, c, x[i + 12], 11, -421815835);
        c = hh(c, d, a, b, x[i + 15], 16, 530742520);
        b = hh(b, c, d, a, x[i + 2], 23, -995338651);

        a = ii(a, b, c, d, x[i + 0], 6, -198630844);
        d = ii(d, a, b, c, x[i + 7], 10, 1126891415);
        c = ii(c, d, a, b, x[i + 14], 15, -1416354905);
        b = ii(b, c, d, a, x[i + 5], 21, -57434055);
        a = ii(a, b, c, d, x[i + 12], 6, 1700485571);
        d = ii(d, a, b, c, x[i + 3], 10, -1894986606);
        c = ii(c, d, a, b, x[i + 10], 15, -1051523);
        b = ii(b, c, d, a, x[i + 1], 21, -2054922799);
        a = ii(a, b, c, d, x[i + 8], 6, 1873313359);
        d = ii(d, a, b, c, x[i + 15], 10, -30611744);
        c = ii(c, d, a, b, x[i + 6], 15, -1560198380);
        b = ii(b, c, d, a, x[i + 13], 21, 1309151649);
        a = ii(a, b, c, d, x[i + 4], 6, -145523070);
        d = ii(d, a, b, c, x[i + 11], 10, -1120210379);
        c = ii(c, d, a, b, x[i + 2], 15, 718787259);
        b = ii(b, c, d, a, x[i + 9], 21, -343485551);

        a = add32(a, oa);
        b = add32(b, ob);
        c = add32(c, oc);
        d = add32(d, od);
      }
      return [a, b, c, d];
    }

    function toHex(n) {
      let s = "";
      for (let i = 0; i < 4; i++) {
        const v = (n >>> (i * 8)) & 0xff;
        s += ("0" + v.toString(16)).slice(-2);
      }
      return s;
    }

    const bytes = toUtf8(String(input));
    const len = bytes.length;
    const words = new Int32Array((((len + 8) >> 6) << 4) + 16);
    for (let i = 0; i < len; i++) {
      words[i >> 2] |= bytes[i] << (8 * (i % 4));
    }
    const result = body(words, len);
    return toHex(result[0]) + toHex(result[1]) + toHex(result[2]) + toHex(result[3]);
  }

  // ---------------------------------------------------------------------------
  // WBI 签名
  // ---------------------------------------------------------------------------
  const MIXIN_KEY_ENC_TAB = [
    46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
    33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40,
    61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11,
    36, 20, 34, 44, 52
  ];

  function getMixinKey(orig) {
    return MIXIN_KEY_ENC_TAB.map((n) => orig[n]).join("").slice(0, 32);
  }

  // 对请求参数做 WBI 签名，返回拼好的 query 串（含 wts 与 w_rid）。
  function encWbi(params, imgKey, subKey) {
    const mixinKey = getMixinKey(imgKey + subKey);
    const wts = Math.round(Date.now() / 1000);
    const chrFilter = /[!'()*]/g;
    const merged = Object.assign({}, params, { wts });
    const query = Object.keys(merged)
      .sort()
      .map((k) => {
        const v = String(merged[k]).replace(chrFilter, "");
        return `${encodeURIComponent(k)}=${encodeURIComponent(v)}`;
      })
      .join("&");
    return query + "&w_rid=" + md5(query + mixinKey);
  }

  async function getWbiKeys(cookie) {
    const headers = {
      "User-Agent": UA,
      Referer: "https://www.bilibili.com/"
    };
    if (cookie) {
      headers["Cookie"] = cookie;
    }
    const res = await fetch("https://api.bilibili.com/x/web-interface/nav", {
      headers
    });
    if (!res.ok) {
      throw new Error("获取 WBI 密钥失败：HTTP " + res.status);
    }
    const json = await res.json();
    if (!json || !json.data || !json.data.wbi_img) {
      throw new Error("获取 WBI 密钥失败：返回结构异常");
    }
    const img = json.data.wbi_img.img_url || "";
    const sub = json.data.wbi_img.sub_url || "";
    const imgKey = img.slice(img.lastIndexOf("/") + 1, img.lastIndexOf("."));
    const subKey = sub.slice(sub.lastIndexOf("/") + 1, sub.lastIndexOf("."));
    return { imgKey, subKey };
  }

  // ---------------------------------------------------------------------------
  // 清晰度映射
  // ---------------------------------------------------------------------------
  const QN_LABEL = {
    127: "8K",
    126: "HDR",
    125: "HDR",
    120: "4K",
    116: "1080P60",
    112: "1080P+",
    108: "1080P",
    80: "1080P",
    74: "720P60",
    64: "720P",
    48: "720P",
    32: "480P",
    16: "360P",
    6: "240P"
  };

  function qnLabel(qn) {
    return QN_LABEL[qn] || "清晰度" + qn;
  }

  // ---------------------------------------------------------------------------
  // 解析 playurl 返回，归一化成可下载流描述
  // ---------------------------------------------------------------------------
  function parsePlayUrl(json, strategyName) {
    if (!json || json.code !== 0) {
      const msg = (json && json.message) || "接口返回错误";
      return { ok: false, error: msg, streams: [] };
    }
    const data = json.data || {};

    // 优先：音视频合一的 MP4（data.durl）
    if (Array.isArray(data.durl) && data.durl.length) {
      const streams = data.durl.map((d, idx) => {
        const url = d.url || (d.backup_url && d.backup_url[0]) || "";
        return {
          kind: "mp4",
          strategy: strategyName,
          quality: data.quality || 0,
          qualityLabel: qnLabel(data.quality || 0),
          url,
          backupUrls: Array.isArray(d.backup_url) ? d.backup_url : [],
          size: d.size || 0,
          segmentIndex: idx,
          segmentCount: data.durl.length,
          filenameSuffix: data.durl.length > 1 ? `-part${idx + 1}` : ""
        };
      });
      return { ok: true, type: "mp4", streams };
    }

    // 退回：DASH（视频 / 音频分开）
    if (data.dash && (Array.isArray(data.dash.video) || Array.isArray(data.dash.audio))) {
      const videos = Array.isArray(data.dash.video) ? data.dash.video : [];
      const audios = Array.isArray(data.dash.audio) ? data.dash.audio : [];
      if (!videos.length) {
        return { ok: false, error: "DASH 流缺少视频轨道", streams: [] };
      }
      // 选带宽最高的视频，选带宽最高的音频
      const video = videos.slice().sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0))[0];
      const audio = audios.length
        ? audios.slice().sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0))[0]
        : null;
      const streams = [
        {
          kind: "dash",
          strategy: strategyName,
          quality: video.id || 0,
          qualityLabel: qnLabel(video.id || 0),
          videoUrl: video.baseUrl || (video.backupUrl && video.backupUrl[0]) || "",
          videoBackupUrls: Array.isArray(video.backupUrl) ? video.backupUrl : [],
          audioUrl: audio ? audio.baseUrl || (audio.backupUrl && audio.backupUrl[0]) || "" : "",
          audioBackupUrls: audio && Array.isArray(audio.backupUrl) ? audio.backupUrl : [],
          width: video.width || 0,
          height: video.height || 0,
          size: (video.bandwidth || 0) * ((data.dash.duration || 0) / 8) || 0
        }
      ];
      return { ok: true, type: "dash", streams };
    }

    return { ok: false, error: "未找到可下载的视频流", streams: [] };
  }

  async function tryPlayUrl({ bvid, cid, cookie, fnval, extra, strategyName }) {
    const keys = await getWbiKeys(cookie);
    const params = Object.assign(
      {
        bvid,
        cid,
        qn: 80,
        fnval: fnval || 16,
        fnver: 0,
        fourk: 1,
        platform: "pc"
      },
      extra || {}
    );
    const signed = encWbi(params, keys.imgKey, keys.subKey);
    const url = "https://api.bilibili.com/x/player/wbi/playurl?" + signed;
    const headers = {
      "User-Agent": UA,
      Referer: "https://www.bilibili.com/",
      Accept: "application/json"
    };
    if (cookie) {
      headers["Cookie"] = cookie;
    }
    const res = await fetch(url, { headers });
    if (!res.ok) {
      throw new Error("取流请求失败：HTTP " + res.status);
    }
    const json = await res.json();
    return parsePlayUrl(json, strategyName);
  }

  // 依次尝试多种取流策略，返回第一个有可用流的解析结果。
  async function resolveBilibili({ bvid, cid, cookie }) {
    const strategies = [
      { name: "html5-mp4", fnval: 1, extra: { platform: "html5", high_quality: 1 } },
      { name: "mp4-look", fnval: 1, extra: { try_look: 1 } },
      { name: "dash", fnval: 16, extra: { fourk: 1 } }
    ];

    let lastError = "";
    for (const st of strategies) {
      try {
        const result = await tryPlayUrl({
          bvid,
          cid,
          cookie,
          fnval: st.fnval,
          extra: st.extra,
          strategyName: st.name
        });
        if (result.ok && result.streams.length) {
          return result;
        }
        lastError = result.error || lastError;
      } catch (e) {
        lastError = e && e.message ? e.message : String(e);
      }
    }

    return {
      ok: false,
      error: lastError || "所有取流策略均未返回可用视频流",
      streams: []
    };
  }

  const API = {
    md5,
    getMixinKey,
    encWbi,
    getWbiKeys,
    parsePlayUrl,
    resolveBilibili,
    qnLabel
  };

  if (typeof module !== "undefined" && module.exports !== undefined) {
    module.exports = API;
  }
  if (typeof globalThis !== "undefined") {
    globalThis.MCD_BILI = API;
  }
})();
