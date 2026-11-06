// =====================================================================
//  docs.js — tela "Converse com seus documentos" (RAG 100% no navegador).
//
//  Fluxo:  arquivo -> trechos -> embeddings locais (embed.js) -> IndexedDB
//          pergunta -> embedding -> trechos mais parecidos (rag.js)
//                   -> WebLLM responde só com eles (llm.js: askDocument)
// =====================================================================
import { hasWebGPU, loadModel, askDocument, stopGeneration, currentModel } from "./llm.js";
import { indexFile, retrieve, fileKind, isOverviewQuestion, overviewPassages } from "./rag.js";
import { loadEmbedder, embedderReady } from "./embed.js";
import { docStore } from "./docstore.js";
import { chatHistory } from "./chat-history.js";
import { $, esc, getModel, initTheme, initSettings, initBackstage } from "./common.js";

const SCREENS = ["pick", "index", "chat"];
const KIND_ICON = { pdf: "📕 PDF", md: "📝 Markdown", txt: "📄 Texto" };
const SUGGESTIONS = ["Sobre o que é este documento?", "Quais são os pontos principais?", "Resuma em 3 frases"];

let doc = null;        // { meta, chunks, vectors, dim } do documento aberto
let history = [];      // [{ q, a }] da conversa atual
let chatId = null;     // id da conversa no histórico (criado na 1ª resposta)
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

// ---------- biblioteca e conversas ----------
async function refreshPick() {
  let docs = [];
  try { docs = await docStore.list(); } catch { /* IndexedDB indisponível (modo privado, etc.) */ }
  renderLibrary(docs);
  renderChats(new Set(docs.map((m) => m.id)));
}

function renderLibrary(docs) {
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
      if (confirm(`Excluir "${m.name}" e o índice dele deste navegador? As conversas salvas continuam.`)) { await docStore.remove(m.id); refreshPick(); }
    };
    list.appendChild(row);
  });
}

// Conversas salvas. `have`: ids dos documentos que ainda estão indexados (dá para continuar).
function renderChats(have) {
  const chats = chatHistory.list();
  $("chats").classList.toggle("hidden", chats.length === 0);
  const list = $("chats-list");
  list.innerHTML = "";
  chats.forEach((c) => {
    const n = c.messages.length;
    const canContinue = have.has(c.docId);
    const meta = [
      `${n} ${n === 1 ? "pergunta" : "perguntas"}`,
      new Date(c.updatedAt).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" }),
      canContinue ? "" : "documento não está mais aqui · só leitura",
    ].filter(Boolean).join(" · ");
    const row = document.createElement("div");
    row.className = "lib-item";
    row.innerHTML = `<span class="grow">${esc(c.docName)}<small>${esc(meta)}</small><small>↳ ${esc(clip(c.messages[n - 1].q, 80))}</small></span>
      <button class="btn btn-green chat-open">${canContinue ? "Continuar" : "Ver"}</button>
      <button class="icon-btn chat-del" title="Excluir" aria-label="Excluir">🗑</button>`;
    row.querySelector(".chat-open").onclick = () => openChat(c.id, canContinue);
    row.querySelector(".chat-del").onclick = () => {
      if (confirm(`Excluir a conversa sobre "${c.docName}"?`)) { chatHistory.remove(c.id); refreshPick(); }
    };
    list.appendChild(row);
  });
}

// ---------- chat ----------
// Mostra a conversa salva; com o documento ainda indexado, dá para continuar perguntando.
async function openChat(id, canContinue) {
  const c = chatHistory.get(id);
  if (!c) return refreshPick();
  if (canContinue && await openDoc(c.docId, "", c)) return;
  openReadOnly(c);
}

function openReadOnly(c) {
  doc = null;
  history = [];
  chatId = null;
  $("chat-doc").textContent = c.docName;
  $("chat-meta").textContent = `💬 ${c.messages.length} ${c.messages.length === 1 ? "pergunta" : "perguntas"} · só leitura`;
  setNote("O documento não está mais neste navegador, então não dá para continuar. Para perguntar de novo, carregue o arquivo outra vez.");
  renderMessages(c.messages);
  $("chat-suggestions").innerHTML = "";
  $("chat-form").classList.add("hidden");
  $("chat-foot").classList.add("hidden");
  show("chat");
}

function renderMessages(messages) {
  $("chat-log").innerHTML = "";
  messages.forEach((m) => {
    addUser(m.q, true);
    const bot = addBot(true);
    bot.text(m.a);
  });
}

// Devolve true se abriu. `chat`: conversa salva para continuar (opcional).
async function openDoc(id, note = "", chat = null) {
  const d = await docStore.get(id);
  if (!d) {
    if (chat) return false;
    show("pick"); refreshPick();
    pickError("Não encontrei esse documento no navegador.");
    return false;
  }
  doc = d;
  history = chat ? chat.messages.map((m) => ({ q: m.q, a: m.a })) : [];
  chatId = chat ? chat.id : null;
  $("chat-form").classList.remove("hidden");
  $("chat-foot").classList.remove("hidden");
  docStore.touch(id).catch(() => {});
  $("chat-doc").textContent = d.meta.name;
  $("chat-meta").textContent = [
    KIND_ICON[d.meta.kind] || d.meta.kind,
    d.meta.pages ? `${d.meta.pages} páginas` : "",
    `${d.meta.chunks} trechos`,
    d.meta.truncated ? `⚠️ ${d.meta.truncated}` : "",
  ].filter(Boolean).join(" · ");
  renderMessages(history);
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
  return true;
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

function addUser(text, quiet = false) {
  const el = document.createElement("div");
  el.className = "msg msg-user";
  el.textContent = text;
  $("chat-log").appendChild(el);
  if (!quiet) el.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

// Mensagem da IA: status, texto (com citações [n]) e trechos usados
// `restored`: resposta vinda do histórico (sem os trechos: as citações [n] ficam só como marcação)
function addBot(restored = false) {
  const el = document.createElement("div");
  el.className = "msg msg-bot" + (restored ? " restored" : "");
  el.innerHTML = `<small class="bot-status"></small><div class="bot-text"></div><div class="srcs hidden"></div>`;
  $("chat-log").appendChild(el);
  const status = el.querySelector(".bot-status"), text = el.querySelector(".bot-text"), srcs = el.querySelector(".srcs");
  if (!restored) el.scrollIntoView({ block: "nearest", behavior: "smooth" });

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
        hits.map((h, i) => `<details class="src"><summary>[${i + 1}] ${esc(h.loc)} <span class="score">· ${h.score == null ? "visão geral" : "similaridade " + h.score.toFixed(2)}</span></summary><p>${esc(h.text)}</p></details>`).join("");
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
    let hits = await retrieve(queries, doc, 4);
    // pergunta geral ("sobre o que é?"): a busca não acha nada específico, então
    // o começo e o índice do documento vêm na frente, e a busca completa o resto
    if (isOverviewQuestion(question)) {
      const intro = overviewPassages(doc);
      const seen = new Set(intro.map((p) => p.index));
      hits = [...intro, ...hits.filter((h) => !seen.has(h.index)).slice(0, 3)];
    }
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
      // salva a conversa (só nome do documento + perguntas e respostas)
      chatId = chatId || chatHistory.newId();
      chatHistory.save({ id: chatId, docId: doc.meta.id, docName: doc.meta.name, messages: history });
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
  $("btn-switch").onclick = () => { if (!busy) { pickError(""); show("pick"); refreshPick(); } };
  $("btn-clear-chat").onclick = (e) => {
    e.preventDefault();
    if (busy) return;
    if (history.length && !confirm("Apagar esta conversa, inclusive do histórico?")) return;
    if (chatId) chatHistory.remove(chatId);
    history = [];
    chatId = null;
    $("chat-log").innerHTML = "";
    renderSuggestions();
  };
  $("btn-clear-chats").onclick = () => {
    if (confirm("Apagar todas as conversas salvas?")) { chatHistory.clear(); refreshPick(); }
  };
}

// ---------- boot ----------
initTheme();
initBackstage();
initSettings();
initPick();
initChat();
refreshPick();
show("pick");
