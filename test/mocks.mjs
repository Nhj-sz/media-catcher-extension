import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * 创建一个可控的 chrome API 模拟对象，并记录各事件监听器与下载调用，
 * 方便在测试中回放消息处理与断言副作用。
 */
export function createChromeMock() {
  const sessionStore = {};
  const downloadCalls = [];
  const listeners = {
    onMessage: null,
    webRequestCompleted: null,
    tabsRemoved: null,
    tabsUpdated: null
  };

  const chrome = {
    runtime: {
      id: "test-extension-id",
      lastError: null,
      onMessage: {
        addListener: (fn) => {
          listeners.onMessage = fn;
        }
      },
      sendMessage: (_payload, cb) => {
        if (typeof cb === "function") {
          cb({ ok: true, items: [] });
        }
      }
    },
    tabs: {
      query: () => Promise.resolve([{ id: 1 }]),
      sendMessage: (_tabId, _payload, cb) => {
        if (typeof cb === "function") {
          cb({ ok: true });
        }
      },
      onRemoved: { addListener: (fn) => { listeners.tabsRemoved = fn; } },
      onUpdated: { addListener: (fn) => { listeners.tabsUpdated = fn; } }
    },
    webRequest: {
      onCompleted: { addListener: (fn) => { listeners.webRequestCompleted = fn; } }
    },
    storage: {
      session: {
        get: (keys) => {
          if (keys == null) {
            return Promise.resolve({ ...sessionStore });
          }
          const arr = Array.isArray(keys) ? keys : [keys];
          const out = {};
          for (const k of arr) {
            if (k in sessionStore) {
              out[k] = sessionStore[k];
            }
          }
          return Promise.resolve(out);
        },
        set: (obj) => {
          Object.assign(sessionStore, obj);
          return Promise.resolve();
        }
      }
    },
    downloads: {
      download: (opts, cb) => {
        downloadCalls.push(opts);
        if (typeof cb === "function") {
          cb(1);
        }
      }
    }
  };

  return { chrome, listeners, sessionStore, downloadCalls };
}

/**
 * 创建一个宽松的 DOM/window 模拟环境。
 * 通过 selectors 可注入 querySelectorAll 的返回值，用于 buildPayload 集成测试。
 */
export function createDomMocks({ topFrame = false, readyState = "loading", selectors = {} } = {}) {
  const makeStyle = () => new Proxy({}, { get: () => "", set: () => true });

  const makeClassList = () => {
    const set = new Set();
    return {
      add: (...c) => c.forEach((x) => set.add(x)),
      remove: (...c) => c.forEach((x) => set.delete(x)),
      toggle: (c, force) => {
        const has = set.has(c);
        const want = force === undefined ? !has : force;
        if (want) set.add(c);
        else set.delete(c);
        return want;
      },
      contains: (c) => set.has(c)
    };
  };

  function makeElement(tag = "div") {
    const attrs = {};
    const base = {
      tagName: String(tag || "div").toUpperCase(),
      style: makeStyle(),
      classList: makeClassList(),
      children: [],
      addEventListener: () => {},
      removeEventListener: () => {},
      appendChild: (child) => {
        base.children.push(child);
        return child;
      },
      removeChild: (child) => {
        base.children = base.children.filter((c) => c !== child);
        return child;
      },
      insertBefore: (child) => child,
      remove: () => {},
      setAttribute: (k, v) => { attrs[k] = String(v); },
      getAttribute: (k) => (k in attrs ? attrs[k] : null),
      removeAttribute: (k) => { delete attrs[k]; },
      querySelector: () => makeElement(),
      querySelectorAll: () => [],
      closest: () => null,
      getBoundingClientRect: () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }),
      focus: () => {},
      click: () => {},
      attachShadow: () => makeShadow(),
      contains: () => false,
      textContent: "",
      innerHTML: "",
      id: "",
      className: "",
      value: "",
      title: "",
      href: "",
      download: "",
      paused: false,
      ended: false,
      currentTime: 0,
      duration: 0,
      videoWidth: 0,
      videoHeight: 0,
      currentSrc: "",
      src: ""
    };
    let shadow = null;
    Object.defineProperty(base, "shadowRoot", {
      get: () => shadow,
      set: (v) => { shadow = v; }
    });
    return base;
  }

  function makeShadow() {
    const shadow = makeElement("div");
    shadow.getElementById = () => makeElement();
    shadow.innerHTML = "";
    return shadow;
  }

  const document = {
    readyState,
    title: "Test Page",
    head: makeElement("head"),
    body: makeElement("body"),
    documentElement: makeElement("html"),
    getElementById: () => makeElement(),
    createElement: (tag) => makeElement(tag),
    querySelector: () => null,
    querySelectorAll: (sel) => (sel in selectors ? selectors[sel] : []),
    addEventListener: () => {},
    contains: () => false,
    location: { href: "https://example.com/page" }
  };

  const windowObj = {
    location: { href: "https://example.com/page" },
    innerWidth: 1280,
    innerHeight: 800,
    addEventListener: () => {},
    removeEventListener: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
    setTimeout: () => 0,
    clearTimeout: () => {}
  };
  windowObj.top = topFrame ? windowObj : {};

  return { window: windowObj, document, makeElement, makeShadow };
}

/**
 * 在 vm 沙箱中加载扩展源码，并通过 export shim 暴露指定顶层函数/对象供测试调用。
 * expose 中的名字必须是源码里真实存在的顶层声明。
 */
export function loadSource(fileName, { expose = [], chrome, window, document, navigator, extraGlobals = {} } = {}) {
  const absolute = path.join(ROOT, fileName);
  const code = readFileSync(absolute, "utf8");

  const sandbox = {
    console,
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout,
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval,
    requestAnimationFrame: (fn) => setTimeout(() => fn(Date.now()), 0),
    cancelAnimationFrame: (id) => clearTimeout(id),
    URL,
    Blob: class Blob {
      constructor(parts, opts) {
        this.parts = parts;
        this.type = (opts && opts.type) || "";
        this.size = (parts && parts[0] && parts[0].length) || 0;
      }
    },
    Map,
    Set,
    WeakMap,
    Date,
    Math,
    JSON,
    Array,
    Object,
    String,
    Number,
    Boolean,
    Promise,
    RegExp,
    Error,
    TypeError,
    parseInt,
    parseFloat,
    isNaN,
    isFinite,
    encodeURIComponent,
    decodeURIComponent,
    chrome: chrome || createChromeMock().chrome,
    window: window || {},
    document: document || makeFallbackDocument(),
    navigator: navigator || { clipboard: { writeText: async () => true } },
    MutationObserver: class MutationObserver {
      constructor(cb) {
        this.cb = cb;
      }
      observe() {}
      disconnect() {}
    },
    ...extraGlobals
  };

  const context = vm.createContext(sandbox);
  const shim = `\n;globalThis.__exports = { ${expose.join(", ")} };`;
  vm.runInContext(code + shim, context, { filename: fileName });
  return sandbox.__exports;
}

function makeFallbackDocument() {
  const style = {};
  const classList = { add() {}, remove() {}, toggle() {}, contains() { return false; } };
  const el = {
    style,
    classList,
    addEventListener() {},
    appendChild() { return el; },
    setAttribute() {},
    getAttribute() { return null; },
    getBoundingClientRect: () => ({}),
    querySelectorAll: () => []
  };
  return {
    readyState: "complete",
    getElementById: () => el,
    createElement: () => el,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
    head: el,
    body: el,
    documentElement: el,
    location: { href: "" },
    title: ""
  };
}
