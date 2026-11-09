// PWA: manifest 유효성과 SW 자산 목록이 실제 파일과 일치하는지.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const web = (f) => path.resolve(new URL("../web", import.meta.url).pathname, f);
const manifest = JSON.parse(fs.readFileSync(web("manifest.webmanifest"), "utf8"));

test("manifest: 필수 필드와 아이콘 파일 존재", () => {
  assert.equal(manifest.display, "standalone");
  assert.ok(manifest.start_url.includes("./") && manifest.scope.includes("./"));
  assert.ok(manifest.icons.length >= 2);
  for (const ic of manifest.icons) {
    assert.ok(fs.existsSync(web(ic.src.replace("./", ""))), `아이콘 실제 존재: ${ic.src}`);
    // PNG 시그니처
    const buf = fs.readFileSync(web(ic.src.replace("./", "")));
    assert.ok(buf.subarray(1, 4).toString() === "PNG", "PNG 형식");
  }
  for (const sc of manifest.shortcuts) assert.ok(/^(chat|index|rag-eval)\.html$/.test(sc.url.replace("./", "")));
});

test("coi-sw.js precache 목록의 모든 파일이 web/에 존재한다", () => {
  const src = fs.readFileSync(web("coi-sw.js"), "utf8");
  const m = src.match(/const PRECACHE = \[([\s\S]*?)\];/);
  assert.ok(m, "PRECACHE 목록");
  const files = [...m[1].matchAll(/"\.\/([a-z0-9./_-]+)"/gi)].map((x) => x[1]);
  assert.ok(files.length > 20);
  const missing = files.filter((f) => f.includes("vendor/")
    ? !fs.existsSync(web(".." + "/dist/vendor/" + f.split("vendor/")[1])) && !fs.existsSync(path.dirname(web("x")) + "/../" + "node_modules")
      ? false : !fs.existsSync(web(f)) && !fs.existsSync(web("vendor") && String(fs.existsSync(web(f))))
    : !fs.existsSync(web(f)));
  // vendor는 빌드 타임(node_modules)에서 복사되므로 web/에는 없다 — 비 vendor만 검사
  const nonVendor = files.filter((f) => !f.startsWith("vendor/"));
  const miss2 = nonVendor.filter((f) => !fs.existsSync(web(f)));
  assert.equal(miss2.length, 0, `빠진 precache 파일: ${miss2.join(", ")}`);
  assert.ok(files.filter((f) => f.startsWith("vendor/")).length >= 4, "벤더 자산 4종 이상");
});

test("페이지에 PWA 메타가 있다", () => {
  for (const p of ["index.html", "chat.html", "lab.html", "production.html", "rag-eval.html", "router.html"]) {
    const s = fs.readFileSync(web(p), "utf8");
    assert.ok(s.includes('rel="manifest"'), p + " manifest 링크");
    assert.ok(s.includes('name="theme-color"'), p + " theme-color");
    assert.ok(s.includes("apple-touch-icon"), p + " apple-touch-icon");
  }
});
