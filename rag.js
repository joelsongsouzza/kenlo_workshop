// =====================================================================
//  rag.js — a parte "R" do RAG, tudo local:
//   1) lê o arquivo (PDF com pdf.js, Markdown/TXT como texto)
//   2) divide em trechos (chunks) de ~900 caracteres
//   3) busca os trechos mais parecidos com a pergunta (cosseno)
//  Os vetores vêm do embed.js; a resposta, do llm.js (askDocument).
// =====================================================================
import { embed, loadEmbedder, EMBED_MODEL, EMBED_DIM } from "./embed.js";
import { docStore } from "./docstore.js";

export const LIMITS = { maxBytes: 25 * 1024 * 1024, maxPages: 300, maxChunks: 800 };
const CHUNK_CHARS = 900;

// ---------- 1) leitura de arquivos ----------
const PDFJS = "https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/";
let pdfjsP = null;
function loadPdfJs() {
  if (!pdfjsP) {
    pdfjsP = (async () => {
      if (!window.pdfjsLib) {
        await new Promise((ok, fail) => {
          const s = document.createElement("script");
          s.src = PDFJS + "pdf.min.js";
          s.onload = ok;
          s.onerror = () => fail(new Error("não consegui baixar o leitor de PDF (pdf.js)"));
          document.head.appendChild(s);
        });
      }
      // O navegador não deixa criar um Worker a partir de outro domínio:
      // baixamos o código do worker e o iniciamos a partir de um blob local.
      const code = await (await fetch(PDFJS + "pdf.worker.min.js")).text();
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(new Blob([code], { type: "text/javascript" }));
      return window.pdfjsLib;
    })();
    pdfjsP.catch(() => { pdfjsP = null; });
  }
  return pdfjsP;
}

export const fileKind = (name) =>
  /\.pdf$/i.test(name) ? "pdf" : /\.(md|markdown)$/i.test(name) ? "md" : /\.txt$/i.test(name) ? "txt" : null;

// PDF -> [{ loc: "p. 3", text }]
async function readPdf(file, onProgress) {
  const lib = await loadPdfJs();
  const pdf = await lib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  const n = Math.min(pdf.numPages, LIMITS.maxPages);
  const parts = [];
  for (let i = 1; i <= n; i++) {
    const content = await (await pdf.getPage(i)).getTextContent();
    const text = content.items.map((it) => it.str + (it.hasEOL ? "\n" : " ")).join("")
      .replace(/-\n(?=[a-zà-ú])/g, "")   // palavra hifenizada na quebra de linha
      .replace(/\s*\n\s*/g, " ")
      .replace(/\s+/g, " ").trim();
    if (text) parts.push({ loc: `p. ${i}`, text });
    onProgress(i, n);
  }
  return { parts, pages: pdf.numPages, truncatedPages: pdf.numPages > n };
}

// Markdown -> uma parte por seção (título), para o trecho "saber" de que seção veio
function readMarkdown(text) {
  const parts = [];
  let heading = "", buf = [];
  const flush = () => { const t = buf.join("\n").trim(); if (t) parts.push({ loc: heading || "início", heading, text: t }); buf = []; };
  for (const line of text.replace(/\r\n?/g, "\n").split("\n")) {
    const m = /^#{1,6}\s+(.*\S)\s*$/.exec(line);
    if (m) { flush(); heading = m[1]; } else buf.push(line);
  }
  flush();
  return parts;
}

// ---------- 2) divisão em trechos ----------
// Junta "unidades" (frases ou parágrafos) até ~max caracteres. A última unidade de um trecho
// se repete no início do próximo (sobreposição), para uma ideia não ser cortada ao meio.
function pack(units, max, sep) {
  const chunks = [];
  let cur = [], len = 0;
  for (const u of units) {
    if (cur.length && len + sep.length + u.length > max) {
      chunks.push(cur.join(sep));
      const tail = cur[cur.length - 1];
      cur = tail.length < max / 3 ? [tail] : [];
      len = cur.length ? tail.length : 0;
    }
    cur.push(u);
    len += (cur.length > 1 ? sep.length : 0) + u.length;
  }
  if (cur.length) chunks.push(cur.join(sep));
  return chunks;
}

// Quebra uma unidade grande demais em pedaços de no máximo `max`
function splitLong(u, max) {
  if (u.length <= max) return [u];
  const out = [];
  let rest = u;
  while (rest.length > max) {
    let cut = rest.lastIndexOf(" ", max);
    if (cut < max / 2) cut = max;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
}

const sentences = (t) => t.split(/(?<=[.!?…])\s+/).flatMap((s) => splitLong(s, CHUNK_CHARS));

export function chunkParts(parts, kind) {
  const chunks = [];
  for (const part of parts) {
    // Markdown: parágrafos/itens como unidades; PDF/TXT: frases
    const units = kind === "md"
      ? part.text.split(/\n{2,}/).map((b) => b.trim()).filter(Boolean).flatMap((b) => (b.length > CHUNK_CHARS ? sentences(b) : [b]))
      : sentences(part.text);
    for (const text of pack(units, CHUNK_CHARS, kind === "md" ? "\n\n" : " ")) {
      if (text.replace(/\s+/g, "").length < 25) continue; // sobras sem conteúdo (números de página, etc.)
      // no Markdown, o título entra no texto do trecho: ajuda a busca e a resposta
      chunks.push({ loc: part.loc, text: part.heading ? `${part.heading}\n${text}` : text });
    }
  }
  return chunks;
}

// ---------- indexação completa ----------
async function fileId(buf) {
  try {
    const h = await crypto.subtle.digest("SHA-256", buf);
    return [...new Uint8Array(h)].slice(0, 10).map((b) => b.toString(16).padStart(2, "0")).join("");
  } catch { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); } // sem crypto.subtle
}

// Lê, divide, gera embeddings e salva. Devolve o id. Se o mesmo arquivo (mesmo conteúdo)
// já foi indexado antes, reaproveita: `{ id, reused: true }`.
// `onStage(etapa, fração, detalhe)`: etapas "read" | "model" | "embed".
export async function indexFile(file, onStage = () => {}) {
  const kind = fileKind(file.name);
  if (!kind) throw new Error("formato não suportado. Use PDF, Markdown (.md) ou texto (.txt).");
  if (file.size > LIMITS.maxBytes) throw new Error(`arquivo grande demais (máx. ${LIMITS.maxBytes / 1048576} MB).`);

  const id = await fileId(await file.arrayBuffer());
  if (await docStore.has(id)) return { id, reused: true };

  onStage("read", 0, "lendo o arquivo...");
  let parts, pages = 0, truncated = [];
  if (kind === "pdf") {
    const r = await readPdf(file, (i, n) => onStage("read", i / n, `página ${i} de ${n}`));
    parts = r.parts; pages = r.pages;
    if (r.truncatedPages) truncated.push(`só as primeiras ${LIMITS.maxPages} páginas`);
    if (!parts.length) throw new Error("este PDF não tem texto selecionável (talvez seja escaneado/imagem). Não há OCR aqui.");
  } else {
    parts = kind === "md" ? readMarkdown(await file.text()) : [{ loc: "texto", text: (await file.text()).replace(/\s+/g, " ").trim() }];
    if (!parts.length) throw new Error("o arquivo está vazio.");
  }

  let chunks = chunkParts(parts, kind);
  if (!chunks.length) throw new Error("não encontrei texto suficiente para indexar.");
  if (chunks.length > LIMITS.maxChunks) {
    chunks = chunks.slice(0, LIMITS.maxChunks);
    truncated.push(`só os primeiros ${LIMITS.maxChunks} trechos`);
  }

  onStage("model", 0, "preparando o modelo de embeddings...");
  await loadEmbedder((f, text) => onStage("model", f, text));

  onStage("embed", 0, `0 de ${chunks.length} trechos`);
  const t0 = performance.now();
  const vecs = await embed(chunks.map((c) => c.text), "passage", (done, total) => onStage("embed", done / total, `${done} de ${total} trechos`));
  const vectors = new Float32Array(vecs.length * EMBED_DIM);
  vecs.forEach((v, i) => vectors.set(v, i * EMBED_DIM));

  const meta = {
    id, name: file.name, kind, size: file.size, pages, chunks: chunks.length,
    truncated: truncated.join(" e "), model: EMBED_MODEL, embedMs: Math.round(performance.now() - t0),
    createdAt: Date.now(), lastOpenedAt: Date.now(),
  };
  await docStore.put(meta, { chunks, vectors, dim: EMBED_DIM });
  return { id, reused: false, meta };
}

// ---------- 3) busca por similaridade ----------
// Os vetores são normalizados: o produto escalar já é o cosseno.
export function topK(queryVec, vectors, dim, k = 4) {
  const n = vectors.length / dim;
  const scores = new Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    const o = i * dim;
    for (let d = 0; d < dim; d++) s += queryVec[d] * vectors[o + d];
    scores[i] = { index: i, score: s };
  }
  return scores.sort((a, b) => b.score - a.score).slice(0, k);
}

// Perguntas gerais sobre o documento inteiro ("sobre o que é?", "resuma", "pontos principais").
// A busca por similaridade não ajuda nelas: nenhum trecho "parece" com a pergunta.
const OVERVIEW_RE = /sobre o que|do que (?:se )?trata|de que (?:se )?trata|o que (?:é|e) (?:este|esse|o) (?:documento|arquivo|texto|pdf)|qual (?:é|e) (?:o )?(?:assunto|tema|objetivo)|assunto|\btema\b|resum|pontos? (?:principais|chave)|principais pontos|ideias? (?:principais|centrais)|vis[aã]o geral|conte[uú]do (?:do|deste)/i;
export const isOverviewQuestion = (q) => OVERVIEW_RE.test(q);

// Trechos que dão a visão geral: índice de seções (Markdown) + começo do documento.
// Mesmo formato dos resultados de retrieve(); `score: null` = não veio da busca.
export function overviewPassages(doc, { intro = 2 } = {}) {
  const out = [];
  const titles = [...new Set(doc.chunks.map((c) => c.loc))];
  if (doc.meta?.kind === "md" && titles.length > 1) {
    out.push({ index: -1, score: null, loc: "índice do documento", text: "Seções do documento: " + clip(titles.join("; "), 700) });
  }
  for (let i = 0; i < Math.min(intro, doc.chunks.length); i++) {
    out.push({ index: i, score: null, loc: "início · " + doc.chunks[i].loc, text: doc.chunks[i].text });
  }
  return out;
}
const clip = (t, n) => (t.length > n ? t.slice(0, n).trimEnd() + "…" : t);

// Pergunta -> trechos mais relevantes: [{ index, score, loc, text }].
// `questions` pode ter mais de uma formulação (ex.: a pergunta sozinha e a pergunta junto com a
// anterior, para continuações como "e o segundo?"). Cada trecho fica com a MAIOR pontuação entre
// elas: se a pessoa mudou de assunto, a pergunta sozinha continua ganhando.
export async function retrieve(questions, doc, k = 4) {
  const qs = await embed([].concat(questions), "query");
  const best = new Map();
  for (const q of qs) {
    for (const h of topK(q, doc.vectors, doc.dim, doc.vectors.length / doc.dim)) {
      if (!best.has(h.index) || h.score > best.get(h.index)) best.set(h.index, h.score);
    }
  }
  return [...best].sort((a, b) => b[1] - a[1]).slice(0, k)
    .map(([index, score]) => ({ index, score, ...doc.chunks[index] }));
}
