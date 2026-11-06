// =====================================================================
//  docs.js — tela "Converse com seus documentos" (RAG 100% no navegador).
//
//  Fluxo:  arquivo -> trechos -> embeddings locais (embed.js) -> IndexedDB
//          pergunta -> embedding -> trechos mais parecidos (rag.js)
//                   -> WebLLM responde só com eles (llm.js: askDocument)
// =====================================================================
import { hasWebGPU, loadModel, askDocument, stopGeneration, currentModel } from "./llm.js";
import { indexFile, retrieve, fileKind } from "./rag.js";
import { loadEmbedder, embedderReady } from "./embed.js";
import { docStore } from "./docstore.js";
import { $, esc, getModel, initTheme, initSettings, initBackstage } from "./common.js";

const SCREENS = ["pick", "index", "chat"];
const KIND_ICON = { pdf: "📕 PDF", md: "📝 Markdown", txt: "📄 Texto" };
const SUGGESTIONS = ["Sobre o que é este documento?", "Quais são os pontos principais?", "Resuma em 3 frases"];

let doc = null;        // { meta, chunks, vectors, dim } do documento aberto
let history = [];      // [{ q, a }] da conversa atual
let busy = false;
let stopped = false;

function show(name) {
  SCREENS.forEach((n) => $("screen-" + n).classList.toggle("hidden", n !== name));
  window.scrollTo(0, 0);
}
const clip = (t, n) => (t.length > n ? t.slice(0, n).trimEnd() + "…" : t);

// ---------- escolher / indexar ----------
function pickError(msg) {
  $("pick-error").textContent = msg || "";
  $("pick-error").classList.toggle("hidden", !msg);
}

const STAGE_TITLE = {
  read: "1/3 · Lendo o documento...",
  model: "2/3 · Preparando o modelo de embeddings...",
  embed: "3/3 · Gerando embeddings dos trechos...",
};

async function handleFile(file) {
  pickError("");
  if (!file) return;
  if (!fileKind(file.name)) return pickError("Formato não suportado. Use PDF, Markdown (.md) ou texto (.txt).");
  $("index-file").textContent = file.name;
  $("index-bar").style.width = "0%";
  $("index-title").textContent = STAGE_TITLE.read;
  $("index-detail").textContent = "";
  show("index");
  try {
    const r = await indexFile(file, (stage, frac, detail) => {
      $("index-title").textContent = STAGE_TITLE[stage];
      $("index-bar").style.width = Math.round(frac * 100) + "%";
      $("index-detail").textContent = detail || "";
    });
    await openDoc(r.id, r.reused ? "Este arquivo já estava indexado: abri direto, sem reprocessar." : "");
  } catch (e) {
    show("pick");
    pickError("Não consegui indexar: " + (e.message || e));
  }
}

async function useSample() {
  pickError("");
  try {
    const res = await fetch("README.md");
    if (!res.ok) throw new Error("README.md não encontrado neste servidor");
    await handleFile(new File([await res.blob()], "README.md", { type: "text/markdown" }));
  } catch (e) { pickError("Não consegui carregar o exemplo: " + e.message); }
}

function initPick() {
  $("file").onchange = (e) => { const f = e.target.files[0]; e.target.value = ""; handleFile(f); };
  $("btn-sample").onclick = useSample;
  const drop = $("drop");
  ["dragenter", "dragover"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("over"); }));
  ["dragleave", "drop"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("over"); }));
  drop.addEventListener("drop", (e) => handleFile(e.dataTransfer.files[0]));
  // soltar um arquivo fora da área não deve abri-lo na aba
  ["dragover", "drop"].forEach((ev) => window.addEventListener(ev, (e) => e.preventDefault()));
}

// ---------- biblioteca ----------
async function renderLibrary() {
  let docs = [];
  try { docs = await docStore.list(); } catch { /* IndexedDB indisponível (modo privado, etc.) */ }
  $("docs-library").classList.toggle("hidden", docs.length === 0);
  const list = $("docs-list");
  list.innerHTML = "";
  docs.forEach((m) => {
    const meta = [
      KIND_ICON[m.kind] || m.kind,
      m.pages ? `${m.pages} ${m.pages === 1 ? "página" : "páginas"}` : "",
      `${m.chunks} trechos`,
      new Date(m.createdAt).toLocaleDateString("pt-BR"),
    ].filter(Boolean).join(" · ");
    const row = document.createElement("div");
    row.className = "lib-item";
    row.innerHTML = `<span class="grow">${esc(m.name)}<small>${esc(meta)}</small></span>
      <button class="btn btn-green doc-open">Abrir</button>
      <button class="icon-btn doc-del" title="Excluir" aria-label="Excluir">🗑</button>`;
    row.querySelector(".doc-open").onclick = () => openDoc(m.id);
    row.querySelector(".doc-del").onclick = async () => {
      if (confirm(`Excluir "${m.name}" e o índice dele deste navegador?`)) { await docStore.remove(m.id); renderLibrary(); }
    };
    list.appendChild(row);
  });
}

// ---------- chat ----------
async function openDoc(id, note = "") {
  const d = await docStore.get(id);
  if (!d) { show("pick"); renderLibrary(); return pickError("Não encontrei esse documento no navegador."); }
  doc = d;
  history = [];
  docStore.touch(id).catch(() => {});
  $("chat-doc").textContent = d.meta.name;
  $("chat-meta").textContent = [
    KIND_ICON[d.meta.kind] || d.meta.kind,
    d.meta.pages ? `${d.meta.pages} páginas` : "",
    `${d.meta.chunks} trechos`,
    d.meta.truncated ? `⚠️ ${d.meta.truncated}` : "",
  ].filter(Boolean).join(" · ");
  $("chat-log").innerHTML = "";
  setNote(note);
  renderSuggestions();
  show("chat");
  $("chat-input").focus();
  // aquece o modelo de embeddings enquanto a pessoa digita a primeira pergunta
  if (!embedderReady()) {
    setNote(note || "🧬 Carregando o modelo de embeddings...");
    loadEmbedder((f, t) => setNote(`🧬 Carregando o modelo de embeddings... ${t}`))
      .then(() => setNote(note), () => setNote(note));
  }
}

function setNote(text) {
  const n = $("chat-note");
  n.textContent = text || "";
  n.classList.toggle("hidden", !text);
}

function renderSuggestions() {
  const box = $("chat-suggestions");
  box.innerHTML = "";
  if (history.length) return;
  SUGGESTIONS.forEach((q) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = q;
    b.onclick = () => { if (!busy) ask(q); };
    box.appendChild(b);
  });
}

function setBusy(on) {
  busy = on;
  $("chat-input").disabled = on;
  $("btn-send").classList.toggle("hidden", on);
  $("btn-stop").classList.add("hidden");
  $("btn-switch").disabled = on;
}

function addUser(text) {
  const el = document.createElement("div");
  el.className = "msg msg-user";
  el.textContent = text;
  $("chat-log").appendChild(el);
  el.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

// Mensagem da IA: status, texto (com citações [n]) e trechos usados
function addBot() {
  const el = document.createElement("div");
  el.className = "msg msg-bot";
  el.innerHTML = `<small class="bot-status"></small><div class="bot-text"></div><div class="srcs hidden"></div>`;
  $("chat-log").appendChild(el);
  const status = el.querySelector(".bot-status"), text = el.querySelector(".bot-text"), srcs = el.querySelector(".srcs");
  el.scrollIntoView({ block: "nearest", behavior: "smooth" });

  // [1] ou [1, 2] viram botões que abrem o trecho correspondente
  const cites = (t) => esc(t).replace(/\[(\d+(?:\s*,\s*\d+)*)\]/g, (_, nums) =>
    nums.split(",").map((n) => `<button type="button" class="cite" data-n="${+n}">${+n}</button>`).join(""));
  text.onclick = (e) => {
    const b = e.target.closest(".cite");
    const d = b && srcs.querySelectorAll("details")[+b.dataset.n - 1];
    if (d) { d.open = true; d.scrollIntoView({ block: "nearest", behavior: "smooth" }); }
  };

  return {
    status: (t) => { status.textContent = t; },
    text: (t) => { text.innerHTML = cites(t); },
    sources(hits) {
      srcs.classList.remove("hidden");
      srcs.innerHTML = `<small>📎 Trechos recuperados pela busca por similaridade (clique para ler):</small>` +
        hits.map((h, i) => `<details class="src"><summary>[${i + 1}] ${esc(h.loc)} <span class="score">· similaridade ${h.score.toFixed(2)}</span></summary><p>${esc(h.text)}</p></details>`).join("");
    },
  };
}

async function ask(question) {
  question = question.trim();
  if (!question || busy || !doc) return;
  $("chat-input").value = "";
  $("chat-suggestions").innerHTML = "";
  setBusy(true);
  stopped = false;
  addUser(question);
  const bot = addBot();
  try {
    // 1) busca: pergunta -> embedding -> trechos mais parecidos
    bot.status("🔎 buscando os trechos mais relevantes...");
    if (!embedderReady()) await loadEmbedder((f, t) => bot.status(`🧬 carregando o modelo de embeddings... ${t}`));
    // pergunta curta de continuação ("e o segundo?") não diz o assunto: também busca junto com a anterior
    const queries = history.length && question.length < 40 ? [question, `${history[history.length - 1].q} ${question}`] : [question];
    const t0 = performance.now();
    const hits = await retrieve(queries, doc, 4);
    bot.sources(hits);
    const searchMs = performance.now() - t0;

    // 2) geração: o WebLLM responde usando só esses trechos
    if (!hasWebGPU()) {
      bot.status("Sem WebGPU neste navegador, então não consigo escrever a resposta. Os trechos mais relevantes estão abaixo.");
      return;
    }
    const modelId = getModel();
    if (currentModel() !== modelId) {
      await loadModel(modelId, (p) => bot.status(`🧠 preparando o modelo... ${Math.round(p.progress * 100)}% · ${p.text}`));
    }
    $("bs-model").textContent = currentModel();
    bot.status("✍️ escrevendo a resposta...");
    $("btn-stop").classList.remove("hidden");
    const t1 = performance.now();
    const answer = await askDocument({
      docName: doc.meta.name,
      passages: hits,
      history: history.slice(-2).map((h) => ({ q: h.q, a: clip(h.a, 400) })),
      question,
    }, (t) => bot.text(t));
    if (stopped) bot.status("⏹ interrompido");
    else {
      history.push({ q: question, a: answer.trim() });
      bot.status(`✨ busca ${(searchMs / 1000).toFixed(1)} s · resposta ${((performance.now() - t1) / 1000).toFixed(1)} s`);
    }
  } catch (e) {
    bot.status("😕 " + (e.message || e));
  } finally {
    setBusy(false);
    $("chat-input").focus();
  }
}

function initChat() {
  $("chat-form").onsubmit = (e) => { e.preventDefault(); ask($("chat-input").value); };
  $("btn-stop").onclick = () => { stopped = true; stopGeneration(); };
  $("btn-switch").onclick = () => { if (!busy) { pickError(""); show("pick"); renderLibrary(); } };
  $("btn-clear-chat").onclick = (e) => {
    e.preventDefault();
    if (busy) return;
    history = [];
    $("chat-log").innerHTML = "";
    renderSuggestions();
  };
}

// ---------- boot ----------
initTheme();
initBackstage();
initSettings();
initPick();
initChat();
renderLibrary();
show("pick");
