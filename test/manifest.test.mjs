import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { ROOT } from "./mocks.mjs";

const manifest = JSON.parse(readFileSync(path.join(ROOT, "manifest.json"), "utf8"));

test("manifest 基础字段合法 (MV3)", () => {
  assert.equal(manifest.manifest_version, 3);
  assert.equal(typeof manifest.name, "string");
  assert.equal(typeof manifest.version, "string");
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.ok(manifest.description, "description 不应为空");
});

test("名称已统一为「抓媒酱」", () => {
  assert.equal(manifest.name, "抓媒酱");
  assert.equal(manifest.action.default_title, "抓媒酱");
  assert.ok(!JSON.stringify(manifest).includes("蚊小西"), "manifest 中不应残留旧名");
});

test("图标资源齐全且文件存在", () => {
  assert.ok(manifest.icons, "缺少 icons");
  for (const size of ["16", "48", "128"]) {
    assert.ok(manifest.icons[size], `缺少 ${size} 图标`);
    assert.ok(
      existsSync(path.join(ROOT, manifest.icons[size])),
      `图标文件不存在: ${manifest.icons[size]}`
    );
  }
  assert.deepEqual(manifest.action.default_icon, manifest.icons);
});

test("content_scripts 已开启 iframe 捕获", () => {
  const script = manifest.content_scripts[0];
  assert.equal(script.all_frames, true);
  assert.equal(script.run_at, "document_idle");
  assert.ok(script.js.includes("content.js"));
});

test("权限与 host 权限满足功能需求", () => {
  for (const perm of ["storage", "downloads", "webRequest", "activeTab", "scripting", "tabs"]) {
    assert.ok(manifest.permissions.includes(perm), `缺少权限: ${perm}`);
  }
  assert.deepEqual(manifest.host_permissions, ["<all_urls>"]);
  assert.equal(manifest.background.service_worker, "background.js");
});
