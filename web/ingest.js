// Document ingestion (Phase 2, from advancedRagDemo's ingestion flow): TXT/MD/PDF → text → chunks →
// embeddings → IndexedDB passages with dataset "uploads". Uploaded documents form their own knowledge base that the
// chat page searches; the corpus stays untouched. Re-uploading byte-identical content is a no-op (content-hash
// doc ids), a small nod to the production lesson that changed documents should not be re-embedded wholesale.
import { chunkText, chunkConfigKey } from "./rag.js";
import * as db from "./store.js";

/** Passage config key — identical expression to pipeline.passageCfg, duplicated here so tests and pages do not
 *  have to pull in the whole pipeline chain. */
export const cfgOf = (embedder, rag) => `${embedder.id}|${chunkConfigKey(rag)}`;
export const UPLOAD_DATASET = "uploads";

/**
 * Text normalization. advancedRagDemo's version strips everything outside printable ASCII
 * (`/[^\x20-\x7E\n]/g`), which silently deletes every Korean character — this is the Korean-safe rewrite:
 * NFC, control characters to spaces, collapse runs of whitespace (including NBSP), keep all printable Unicode.
 */
export function normalizeText(text) {
  return String(text || "")
    .normalize("NFC")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ") // control chars except \t \n \r
    .replace(/[ \t\u00A0\u2000-\u200B\u3000]+/g, " ")                 // spaces, NBSP, zero-width, id. spaces
    .trim();
}

/** FNV-1a of the text — stable content-hash doc id across visits and browsers. */
export function contentHash(text) {
  const s = String(text || "");
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36);
}

/** Parse TXT/MD as UTF-8. (parsePdf is async-loadable below.) */
export async function parseTxt(file) { return await file.text(); }

/** Extract text page by page with pdf.js (vendored at vendor/pdf.min.mjs; worker + CMaps shipped alongside). */
export async function parsePdf(file, onProgress = () => {}) {
  const pdfjs = await import("./vendor/pdf.min.mjs");
  pdfjs.GlobalWorkerOptions.workerSrc = new URL("./vendor/pdf.worker.min.mjs", import.meta.url).href;
  const pdf = await pdfjs.getDocument({ data: await file.arrayBuffer(), cMapUrl: new URL("./vendor/cmaps/", import.meta.url).href, cMapPacked: true }).promise;
  const pages = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const tc = await page.getTextContent();
    let text = "";
    let last = null;
    for (const item of tc.items) {
      // PDF items arrive in reading order per line; insert a space between separated runs, none inside a run —
      // joining everything with " " would split Korean words that pdf.js emits as separate glyph clusters.
      if (last != null && item.transform?.[4] != null && last[4] != null) {
        const gap = item.transform[4] - last[4], size = (last[5] || item.transform[5] || 10);
        if (gap > size * 0.3) text += " ";
      }
      if (item.hasEOL) text += "\n";
      text += item.str;
      last = item.transform;
    }
    pages.push({ pageNumber: i, text: text.replace(/[ \t]+/g, " ").trim() || `[빈 페이지 ${i}]` });
    onProgress(i, pdf.numPages);
  }
  return pages;
}

export const kindOf = (name) => (/\.pdf$/i.test(name) ? "pdf" : /\.(txt|md|mdown|markdown|csv|json)$/i.test(name) ? "txt" : null);

/**
 * Parse, normalize, chunk, embed and store one file.
 * @returns { docId, name, chunks, embedded, ms } — docId is a content hash, so identical content re-uploads are skipped.
 */
export async function ingestFile(file, rag, embedder, onProgress = () => {}) {
  const kind = kindOf(file.name);
  if (!kind) throw new Error(`지원하지 않는 파일 형식입니다: ${file.name} (PDF, TXT, MD만 지원)`);
  const t0 = performance.now();
  const raw = kind === "pdf" ? (await parsePdf(file, onProgress)).map((p) => `## p${p.pageNumber} ${p.text}`).join("\n") : await parseTxt(file);
  const text = normalizeText(raw);
  if (!text) throw new Error("문서에서 텍스트를 추출하지 못했습니다 (스캔본 PDF라면 OCR이 필요합니다).");
  const docId = `up:${contentHash(text)}`;
  const parts = chunkText(text, rag);
  const have = await db.passages(cfgOf(embedder, rag), docId);
  let embedded = 0;
  if (have.length !== parts.length || have.some((p, j) => p.text !== parts[j].text)) {
    onProgress(0, parts.length, "임베딩 중…");
    const vecs = await embedder.embed(parts.map((p) => p.text));
    onProgress(parts.length, parts.length, "IndexedDB에 저장 중…");
    await db.putMany("passages", parts.map((p, j) => ({
      key: `${cfgOf(embedder, rag)}|${UPLOAD_DATASET}|${docId}|${p.index}`, cfg: cfgOf(embedder, rag),
      dataset: UPLOAD_DATASET, docId, chunk: p.index, text: p.text, vec: vecs[j],
    })));
    embedded = parts.length;
  }
  // uploads registry: one meta row, the whole list — small, and survives the memory fallback.
  const list = ((await db.get("meta", "uploads"))?.docs || []).filter((d) => d.docId !== docId);
  list.push({ docId, name: file.name, kind, size: file.size, chunks: parts.length, addedAt: new Date().toISOString() });
  await db.putMany("meta", [{ key: "uploads", docs: list }]);
  return { docId, name: file.name, chunks: parts.length, embedded, reused: embedded === 0, ms: performance.now() - t0 };
}

export async function listUploads() { return (await db.get("meta", "uploads"))?.docs || []; }

/** Remove one uploaded document: its passages and its registry entry. */
export async function removeUpload(docId, rag, embedder) {
  const cfg = cfgOf(embedder, rag ?? { sentencesPerChunk: 2, overlap: 0 });
  for (const p of await db.passages(cfg, docId)) await db.del("passages", p.key);
  const list = ((await db.get("meta", "uploads"))?.docs || []).filter((d) => d.docId !== docId);
  await db.putMany("meta", [{ key: "uploads", docs: list }]);
}

/** Uploaded-passage pool for retrieval (chat page): rows in the shape hybridTopK/topK expect. */
export async function uploadPool(embedder, rag = { sentencesPerChunk: 2, overlap: 0 }) {
  return (await db.passages(cfgOf(embedder, rag), null)).filter((p) => p.dataset === UPLOAD_DATASET);
}
