// "프로덕션 Lab" 페이지: 9개 rung를 돌리고 없음/있음 표로 요약 + 카오스 위크 채점. runAll()은 결정적이라 캐시된다.
import { $, esc } from "./common.js";
import { settings } from "./common.js";
import { runAll, chaosWeek, RUNGS, REQUIRES } from "./prodLab.js";

let R = null;

function num(n) { return n == null ? "–" : typeof n === "number" ? n.toLocaleString("ko-KR") : n; }
const pct = (p) => Math.round(p * 100) + "%";

function fillFixes() {
  const saved = settings.get("chaosFixes", []);
  for (const cb of document.querySelectorAll("#fixes input")) cb.checked = saved.includes(cb.value);
  return document.querySelectorAll("#fixes input:checked").length;
}

function runRungs() {
  R = runAll();
  $("prodMeta").textContent = `결정적 시뮬레이션 · 실행 ${R.ms.toLocaleString()}ms (한 번 계산, 캐시)`;
  $("rungs").innerHTML = `<table class="grid"><thead><tr><th>#</th><th>장애</th><th>fix</th><th>fix 없이</th><th>fix 있음</th></tr></thead><tbody>${
    RUNGS.map((r) => {
      const d = R[r.n], cells = cellsFor(r, d);
      return `<tr class="claimrow" data-n="${r.n}" tabindex="0" role="button" aria-expanded="false"><td>${r.n}</td><td>${esc(r.problem)}</td><td>${esc(r.fix)}</td><td>${cells[0]}</td><td>${cells[1]}</td></tr>`;
    }).join("")}</tbody></table>` + `<p class="caption">행을 누르면 상세를 볼 수 있습니다.</p>`;
  document.querySelectorAll("#rungs .claimrow").forEach((tr) => tr.addEventListener("click", () => showDetail(+tr.dataset.n)));
  document.querySelectorAll("#rungs .claimrow").forEach((tr) => tr.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); showDetail(+tr.dataset.n); } }));
}

function cellsFor(r, d) {
  switch (r.n) {
    case 1: return [`${num(d.without.embeds)} 임베딩 (2천만 벡터라면 ${d.without.projected})`, `${num(d.with.embeds)} 임베딩 (${d.with.projected})`];
    case 2: return [`${num(d.without.embeds)} 임베딩 (문장 1개 변경에도)`, `${num(d.with.embeds)} 임베딩 · ${d.chunks}개 중 ${d.with.cascade}개 연쇄 (바뀐 곳: ${d.with.firstChange + 1}번째)`];
    case 3: return [`${d.without.label}: ${num(d.without.embeds)}`, `${d.with.label}: ${num(d.with.embeds)}`];
    case 4: return [d.without.facts.length > 1 ? `크래시 후 규정이 “${d.without.facts.join("일과 ")}일”을 섞어 답한다` : `적용 ${d.without.applied}/${d.without.of}`, `활성 ${d.with.active} · 대기 v${d.with.pending} · 읽기는 "연차 ${d.with.facts[0]}일" 하나만`];
    case 5: return [`전환 즉시 → ${pct(d.without.coveragePct)}만 검색 가능`, `모든 쓰기 착지 후 → ${pct(d.with.coveragePct)} 검색 가능`];
    case 6: return [`${num(d.without.total)} 벡터 중 ${pct(d.without.stalePct)} 부패`, `GC 후 ${num(d.with.total)} 벡터 (부패 ${d.with.stale})`];
    case 7: return [`recall@5 ${pct(d.without.recall)}로 하락 (v1 질의는 ${pct(d.without.recallOldQueries)})`, `recall 유지: 이전 ${pct(d.before)} → 이중 기록 ${pct(d.with.recallDuring)} → 전환 ${pct(d.with.recall)}`];
    case 8: return [`이벤트 ${d.without.stale.length}건 소실 · 답 “${d.without.answer}년마다” (진실 ${d.truth})`, `스윕이 ${d.with.repaired.length}개 복구 · 답 “${d.with.answer}년마다”`];
    case 9: return [`캐시가 옛 답 “${d.without.answer}년마다” 제공`, d.with.answer != null ? `출처 버전 확인 후 새 답 “${d.with.answer}년마다”` : "–"];
    default: return ["", ""];
  }
}

function showDetail(n) {
  const r = RUNGS.find((x) => x.n === n), d = R[n];
  if (!r || !d) return;
  $("detailCard").hidden = false;
  $("detailTitle").textContent = `Rung ${n} 상세 — ${r.fix}`;
  $("detail").innerHTML = detailBody(n, d);
  $("detailJson").textContent = JSON.stringify(d, (k, v) => v instanceof Float32Array ? `[벡터 ${v.length}d]` : v, 1);
  $("detailCard").scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function detailBody(n, d) {
  const kv = (obj) => Object.entries(obj).map(([k, v]) => `<div><b>${esc(k)}</b> ${Array.isArray(v) ? esc(JSON.stringify(v)).slice(0, 120) : esc(String(v))}</div>`).join("");
  switch (n) {
    case 2: {
      const strip = d.with.strip;
      return `<p class="hint">문자열 strip: 각 청크가 재사용(해시 보존)인지 다시 임베딩인지. 연쇄(cascade) = 편집 지점부터 문서 끝까지 다시 임베딩되는 청크 수.</p><table class="grid"><thead><tr><th>#</th><th>절</th><th>재사용</th></tr></thead><tbody>${
        strip.map((c, i) => `<tr${c.reused ? "" : ' class="focus"'}><td>${i + 1}</td><td>${esc(c.section)}</td><td><span class="tag ${c.reused ? "ok" : "bad"}">${c.reused ? "재사용" : "재임베딩"}</span></td></tr>`).join("")}</tbody></table>`;
    }
    case 5: {
      const row = (side) => side.coverage.map((c) => `<span class="tag ${c.present ? "ok" : "bad"}">${esc(c.section)}.${c.para + 1}</span>`).join(" ");
      return `<p class="hint">활성 버전의 문단 커버리지: 배포 중 검색하면 비원자 전환은 규정의 일부만 검색 가능하다.</p><table class="grid"><tbody><tr><th>fix 없이</th><td>${row(d.without)} (${pct(d.without.coveragePct)})</td></tr><tr><th>fix 있음</th><td>${row(d.with)} (${pct(d.with.coveragePct)})</td></tr></tbody></table>`;
    }
    case 6: {
      const pts = d.without.series.map(([e, t, st]) => `<tr><td>편집 ${e}</td><td class="r">${num(t)}</td><td class="r">${num(st)}</td></tr>`).join("") + d.with.series.map(([e, t, st]) => `<tr><td>편집 ${e} <span class="tag ok">GC</span></td><td class="r">${num(t)}</td><td class="r">${num(st)}</td></tr>`).join("");
      return `<p class="hint">인덱스 크기와 부패(비활성) 벡터 수.</p><table class="grid"><thead><tr><th>시점</th><th class="r">전체</th><th class="r">부패</th></tr></thead><tbody>${pts}</tbody></table>`;
    }
    case 7: {
      const mix = (m) => `v1=${num(m.v1)} · v2=${num(m.v2)}`;
      return `<table class="grid"><tbody>
        <tr><th>전환 전 recall@5</th><td>${pct(d.before)} (${d.questions} 질문)</td></tr>
        <tr><th>fix 없이</th><td>recall@5 ${pct(d.without.recall)} · 옛 질의로는 ${pct(d.without.recallOldQueries)} · 혼합 ${mix(d.without.mix)}</td></tr>
        <tr><th>fix 있음</th><td>이중 기록 중 ${pct(d.with.recallDuring)} → 전환 ${pct(d.with.recall)} · ${mix(d.with.mix)} · 재임베딩 ${num(d.with.reembedded)}</td></tr>
      </tbody></table>`;
    }
    case 4: {
      const hits = h => (h || []).map(x => `<li class="passage"><span class="rank">${x.section}</span><div><div class="txt" style="font-size:12.5px">${esc(x.text.replace(/\n/g, " ").slice(0, 90))}…</div></div></li>`).join("");
      return `<p class="hint">질문 “${esc(d.query)}” · ${d.crashAt * 100}%쯤 크래시. 사실(연차 일수)이 인덱스에 섞였는가.</p>
        <div class="two"><div><b>fix 없이</b> (적용 ${d.without.applied}/${d.without.of})<ol class="passages">${hits(d.without.hits)}</ol>facts ${esc(JSON.stringify(d.without.facts))}</div>
        <div><b>fix 있음</b> (활성 v${d.with.active}, 대기 v${d.with.pending})<ol class="passages">${hits(d.with.hits)}</ol>facts ${esc(JSON.stringify(d.with.facts))}</div></div>`;
    }
    default:
      return `<div class="two"><div><b>fix 없이</b><div style="font-size:13px" class="stack">${kv(flatten(d.without))}</div></div><div><b>fix 있음</b><div style="font-size:13px" class="stack">${kv(flatten(d.with))}</div></div></div>`;
  }
}

const flatten = (o) => { const out = {}; for (const [k, v] of Object.entries(o || {})) { if (Array.isArray(v) && v.length > 10) out[k] = `[${v.length}개]`; else if (typeof v !== "object" || v == null) out[k] = v; else out[k] = JSON.stringify(v).slice(0, 80); } return out; };

// ---- chaos week ----------------------------------------------------------------------

function runChaos() {
  const fixes = {};
  for (const cb of document.querySelectorAll("#fixes input")) if (cb.checked) fixes[cb.value] = true;
  settings.set("chaosFixes", Object.keys(fixes));
  const cw = chaosWeek(fixes);
  $("chaosOut").innerHTML = `<div class="outcome ${cw.passed >= 6 ? "auto" : cw.passed >= 4 ? "human" : "block"}"><div class="k">${cw.passed}/7 통과</div><div class="t">등급 ${cw.grade}</div></div>
    <table class="grid"><thead><tr><th>요일</th><th>사건</th><th>영향</th></tr></thead><tbody>${
    cw.incidents.map((i) => `<tr class="${i.ok ? "" : "focus"}"><td>${esc(i.day)}</td><td>${esc(i.what)}</td><td><span class="tag ${i.ok ? "ok" : "bad"}">${i.ok ? "통과" : "실패"}</span> ${esc(i.impact)} <span class="meta">rung ${i.rungs.join(",")}</span></td></tr>`).join("")}</tbody></table>`;
}

$("chaosBtn").addEventListener("click", runChaos);
document.querySelectorAll("#fixes input").forEach((cb) => cb.addEventListener("change", runChaos));
fillFixes();
runRungs();
runChaos();
