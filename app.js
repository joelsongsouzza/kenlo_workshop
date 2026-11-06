// =====================================================================
//  app.js — interface e gamificação. Nada de WebLLM direto aqui:
//  tudo passa pelo llm.js.
// =====================================================================
import { hasWebGPU, loadModel, generateItem, streamText, stopGeneration, currentModel } from "./llm.js";
import { library } from "./library.js";
import { fetchFacts } from "./wiki.js";
import { $, esc, store, getModel, initTheme, initSettings, initBackstage } from "./common.js";

const SUGGESTIONS = ["Fotossíntese", "Docker", "Revolução Francesa", "Machine Learning", "Sistema Solar", "Git e GitHub"];
const SCREENS = ["nogpu", "setup", "loading", "game", "result"];

// ---------- estado ----------
const state = {
  mode: "quiz", level: "iniciante", topic: "", context: "", total: 5,
  items: [], current: 0, hearts: 3, xp: 0, combo: 0, results: [],
  runId: 0, waiting: false, genError: null, answered: false,
  libId: null, // id do estudo na biblioteca (perguntas salvas no navegador)
};

// ---------- persistência simples (XP total + streak diário) ----------
// (o `store` vem do common.js)
function renderStats() {
  const s = store.get();
  $("stat-xp").textContent = s.xp || 0;
  $("stat-streak").textContent = s.streak || 0;
}
function registerStudyDay(xpGained) {
  const s = store.get();
  const today = new Date().toDateString();
  if (s.lastDay !== today) {
    const yesterday = new Date(Date.now() - 864e5).toDateString();
    s.streak = s.lastDay === yesterday ? (s.streak || 0) + 1 : 1;
    s.lastDay = today;
  }
  s.xp = (s.xp || 0) + xpGained;
  store.set(s);
  renderStats();
}

initTheme();

// ---------- navegação ----------
function show(name) {
  SCREENS.forEach((n) => $("screen-" + n).classList.toggle("hidden", n !== name));
  if (name === "setup") renderLibrary();
  $("feedback").classList.add("hidden");
  window.scrollTo(0, 0);
}

// ---------- som e confete ----------
let audio;
function beep(freqs, dur = 0.12) {
  try {
    audio = audio || new AudioContext();
    freqs.forEach((f, i) => {
      const o = audio.createOscillator(), g = audio.createGain();
      o.frequency.value = f; o.type = "triangle";
      g.gain.setValueAtTime(0.15, audio.currentTime + i * dur);
      g.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + (i + 1) * dur);
      o.connect(g).connect(audio.destination);
      o.start(audio.currentTime + i * dur); o.stop(audio.currentTime + (i + 1) * dur);
    });
  } catch {}
}
const sfx = { ok: () => beep([660, 880]), bad: () => beep([220, 160], 0.18), win: () => beep([523, 659, 784, 1047], 0.14) };
function confetti() {
  const box = $("confetti"), colors = ["#58cc02", "#1cb0f6", "#ffc800", "#ff4b4b", "#ce82ff"];
  for (let i = 0; i < 90; i++) {
    const p = document.createElement("i");
    p.style.left = Math.random() * 100 + "vw";
    p.style.background = colors[i % colors.length];
    p.style.animationDuration = 2 + Math.random() * 2 + "s";
    p.style.animationDelay = Math.random() * 0.6 + "s";
    box.appendChild(p);
    setTimeout(() => p.remove(), 5000);
  }
}

// ---------- tela de configuração ----------
function initSetup() {
  SUGGESTIONS.forEach((t) => {
    const b = document.createElement("button");
    b.textContent = t;
    b.onclick = () => { $("topic").value = t; $("topic").focus(); };
    $("suggestions").appendChild(b);
  });
  for (const [id, key] of [["level", "level"], ["mode", "mode"]]) {
    $(id).onclick = (e) => {
      const btn = e.target.closest("button"); if (!btn) return;
      [...$(id).children].forEach((c) => c.classList.toggle("active", c === btn));
      state[key] = btn.dataset.v;
    };
  }
  $("count").oninput = () => { $("count-label").textContent = $("count").value; };
  $("btn-loading-back").onclick = () => show("setup");
  $("btn-start").onclick = startSession;
  $("topic").onkeydown = (e) => { if (e.key === "Enter") startSession(); };
}

// ---------- biblioteca (estudos salvos no navegador) ----------
const LEVEL_ICON = { "iniciante": "🌱", "intermediário": "🌿", "avançado": "🌳" };

function renderLibrary() {
  const sets = library.list();
  $("library").classList.toggle("hidden", sets.length === 0);
  const list = $("library-list");
  list.innerHTML = "";
  sets.forEach((e) => {
    const n = e.items.length;
    const meta = [
      e.mode === "quiz" ? "🎯 Quiz" : "🃏 Flashcards",
      `${LEVEL_ICON[e.level] || ""} ${e.level}`,
      `${n} ${n === 1 ? "item" : "itens"}`,
      new Date(e.createdAt).toLocaleDateString("pt-BR"),
      e.last ? `último: ${e.last.hits}/${e.last.total}` : "ainda não jogado",
    ].join(" · ");
    const row = document.createElement("div");
    row.className = "lib-item";
    row.innerHTML = `<span class="grow">${esc(e.topic)}<small>${esc(meta)}</small></span>
      <button class="btn btn-green lib-play">▶ Rejogar</button>
      <button class="icon-btn lib-del" title="Excluir" aria-label="Excluir">🗑</button>`;
    row.querySelector(".lib-play").onclick = () => startReplay(e.id);
    row.querySelector(".lib-del").onclick = () => {
      if (confirm(`Excluir "${e.topic}" da sua biblioteca?`)) { library.remove(e.id); renderLibrary(); }
    };
    list.appendChild(row);
  });
}

// Rejoga um estudo salvo: usa as perguntas guardadas, sem carregar nem chamar o modelo.
function startReplay(id) {
  const e = library.get(id);
  if (!e) return renderLibrary();
  Object.assign(state, {
    mode: e.mode, level: e.level, topic: e.topic, context: e.context || "",
    items: e.items.map((i) => ({ ...i })), total: e.items.length,
    current: 0, hearts: 3, xp: 0, combo: 0, results: [],
    waiting: false, genError: null, answered: false, runId: state.runId + 1,
    libId: e.id, facts: null,
  });
  $("game-source").classList.add("hidden");
  show("game");
  renderHearts();
  showCurrent();
}

// ---------- iniciar sessão ----------
async function startSession() {
  const topic = $("topic").value.trim();
  if (!topic) { $("topic").focus(); $("topic").style.borderColor = "var(--red)"; return; }
  $("topic").style.borderColor = "";
  Object.assign(state, {
    // nível e modo vêm dos botões da tela (rejogar um estudo salvo muda o state)
    level: $("level").querySelector(".active").dataset.v,
    mode: $("mode").querySelector(".active").dataset.v,
    topic, context: $("context").value.trim(), total: +$("count").value,
    items: [], current: 0, hearts: 3, xp: 0, combo: 0, results: [],
    waiting: false, genError: null, answered: false, runId: state.runId + 1,
    libId: library.newId(), facts: null,
  });

  show("loading");
  // busca na Wikipédia enquanto o modelo carrega (não atrasa nada); falhou = segue sem
  const factsP = $("use-wiki").checked ? fetchFacts(topic) : Promise.resolve(null);
  try { await ensureModel(getModel()); }
  catch { return; }
  state.facts = await factsP;
  const src = $("game-source");
  if (state.facts) {
    src.innerHTML = `Base: <a href="${esc(state.facts.url)}" target="_blank" rel="noopener">Wikipédia · ${esc(state.facts.title)}</a>`;
  } else {
    src.textContent = $("use-wiki").checked ? "Sem artigo confiável na Wikipédia: perguntas só com o conhecimento do modelo." : "";
  }
  src.classList.toggle("hidden", !src.textContent);
  show("game");
  renderHearts();
  showCurrent();
  generateLoop(state.runId);
}

async function ensureModel(modelId) {
  if (currentModel() === modelId) return;
  $("loading-error").classList.add("hidden");
  $("btn-loading-back").classList.add("hidden");
  $("loading-bar").style.width = "0%";
  try {
    await loadModel(modelId, (p) => {
      $("loading-bar").style.width = Math.round(p.progress * 100) + "%";
      $("loading-detail").textContent = p.text;
    });
    $("bs-model").textContent = currentModel();
  } catch (e) {
    $("loading-error").textContent = "Não consegui carregar o modelo: " + e.message +
      "\n\nDicas: escolha o modelo Leve; libere espaço em disco; desative VPN/proxy/bloqueadores " +
      "(os arquivos vêm de huggingface.co e raw.githubusercontent.com); e tente de novo.";
    $("loading-error").style.whiteSpace = "pre-wrap";
    $("loading-error").classList.remove("hidden");
    $("btn-loading-back").classList.remove("hidden");
    throw e;
  }
}

// Gera as perguntas uma a uma em segundo plano: o usuário já joga a
// primeira enquanto as outras ainda estão sendo criadas.
async function generateLoop(runId) {
  state.genError = null;
  while (state.items.length < state.total) {
    if (runId !== state.runId) return;
    try {
      const item = await generateItem({
        mode: state.mode, topic: state.topic, level: state.level, context: state.context, facts: state.facts,
        index: state.items.length, total: state.total,
        previous: state.items.map((i) => i.question || i.front),
      });
      if (runId !== state.runId) return;
      state.items.push(item);
      // salva a cada pergunta gerada: mesmo que o usuário saia antes do fim, nada se perde
      library.saveSet({ id: state.libId, topic: state.topic, context: state.context,
                        level: state.level, mode: state.mode, items: state.items });
      if (state.waiting && state.items.length - 1 === state.current) { state.waiting = false; showCurrent(); }
    } catch (e) {
      if (runId !== state.runId) return;
      state.genError = e.message || "erro desconhecido";
      if (state.waiting) showCurrent();
      return;
    }
  }
}

// ---------- jogo ----------
function renderHearts() {
  $("hearts").textContent = state.mode === "quiz" ? "❤️".repeat(state.hearts) + "🖤".repeat(3 - state.hearts) : "";
}
function renderProgress() {
  $("game-bar").style.width = (state.current / state.total) * 100 + "%";
  $("game-count").textContent = `Pergunta ${Math.min(state.current + 1, state.total)} de ${state.total} · ${state.xp} XP`;
  $("combo").textContent = state.combo >= 2 ? `🔥 combo x${state.combo}` : "";
}

function showCurrent() {
  $("feedback").classList.add("hidden");
  state.answered = false;
  renderProgress();
  const body = $("game-body");
  const item = state.items[state.current];

  if (!item) {
    state.waiting = true;
    body.innerHTML = state.genError
      ? `<div class="loading-q"><div class="error">A IA se atrapalhou: ${esc(state.genError)}</div>
         <button class="btn" id="btn-retry" style="margin-top:14px">Tentar de novo</button></div>`
      : `<div class="loading-q"><div class="spinner"></div>A coruja está criando a pergunta...</div>`;
    const r = $("btn-retry");
    if (r) r.onclick = () => { generateLoop(state.runId); showCurrent(); };
    return;
  }
  state.mode === "quiz" ? renderQuiz(item) : renderFlash(item);
}

function renderQuiz(q) {
  const body = $("game-body");
  body.innerHTML = `<p class="q-text">${esc(q.question)}</p><div class="options"></div>`;
  const box = body.querySelector(".options");
  q.options.forEach((opt, i) => {
    const b = document.createElement("button");
    b.className = "option";
    b.innerHTML = `<span class="key">${i + 1}</span><span>${esc(opt)}</span>`;
    b.onclick = () => answerQuiz(i, q);
    box.appendChild(b);
  });
}

function answerQuiz(i, q) {
  if (state.answered) return;
  state.answered = true;
  const ok = i === q.correctIndex;
  [...document.querySelectorAll(".option")].forEach((b, idx) => {
    b.disabled = true;
    if (idx === q.correctIndex) b.classList.add("correct");
    else if (idx === i) b.classList.add("wrong");
  });
  state.results.push({ question: q.question, correct: ok, chosen: q.options[i], answer: q.options[q.correctIndex] });
  grade(ok, q.explanation, q);
}

function renderFlash(c) {
  const body = $("game-body");
  body.innerHTML = `<div class="flash"><div class="flash-inner"><div><small>FRENTE · toque para virar</small>${esc(c.front)}</div></div></div>`;
  body.querySelector(".flash").onclick = () => {
    if (state.answered) return;
    const inner = body.querySelector(".flash-inner");
    inner.classList.add("back");
    inner.innerHTML = `<div><small>VERSO</small>${esc(c.back)}</div>`;
    const act = document.createElement("div");
    act.className = "flash-actions";
    act.innerHTML = `<button class="btn btn-red">Errei</button><button class="btn btn-green">Acertei</button>`;
    body.appendChild(act);
    const [no, yes] = act.children;
    const done = (ok) => {
      if (state.answered) return;
      state.answered = true;
      act.remove();
      state.results.push({ question: c.front, correct: ok, answer: c.back });
      grade(ok, ok ? "Mandou bem!" : "Sem problema, vamos revisar: " + c.back, c);
    };
    no.onclick = (e) => { e.stopPropagation(); done(false); };
    yes.onclick = (e) => { e.stopPropagation(); done(true); };
  };
}

// Pontuação + barra de feedback
function grade(ok, text, item) {
  if (ok) { state.combo++; state.xp += 10 + Math.min(state.combo - 1, 5) * 2; sfx.ok(); }
  else { state.combo = 0; if (state.mode === "quiz") state.hearts--; sfx.bad(); }
  renderHearts(); renderProgress();

  const fb = $("feedback");
  fb.classList.remove("hidden");
  fb.classList.toggle("bad", !ok);
  fb.classList.toggle("good", ok);
  $("feedback-title").textContent = ok ? "✅ Correto!" : "❌ Ops!";
  $("feedback-text").textContent = text || "";
  $("explain-box").classList.add("hidden");
  $("explain-box").textContent = "";
  // sem modelo carregado (rejogando um estudo salvo) não há como explicar mais
  $("btn-explain").classList.toggle("hidden", ok || !currentModel());
  $("btn-explain").disabled = false;
  $("btn-explain").onclick = () => explainMore(item);
  const last = state.current + 1 >= state.total || state.hearts <= 0;
  $("btn-next").textContent = last ? "VER RESULTADO" : "CONTINUAR";
}

// "Me explica melhor": chat com streaming
async function explainMore(item) {
  const box = $("explain-box");
  box.classList.remove("hidden");
  box.textContent = "🦉 pensando...";
  $("btn-explain").disabled = true;
  const subject = item.question ? `Pergunta: ${item.question}\nResposta correta: ${item.options[item.correctIndex]}` : `Termo: ${item.front}\nResposta: ${item.back}`;
  try {
    await streamText([
      { role: "system", content: "Você é um professor paciente. Explique em português do Brasil, de forma simples, com um exemplo do dia a dia. Máximo de 4 frases. Sem markdown." },
      { role: "user", content: `Tema: ${state.topic}. Nível: ${state.level}.\n${subject}\n\nO aluno errou. Explique melhor.` },
    ], (t) => { box.textContent = t; }, 220);
  } catch (e) { box.textContent = "Não consegui explicar agora: " + e.message; }
}

function next() {
  state.current++;
  if (state.current >= state.total || state.hearts <= 0) return finish();
  showCurrent();
}

// ---------- resultado ----------
async function finish() {
  state.runId++;          // cancela a geração em andamento
  stopGeneration();
  const total = state.results.length;
  const hits = state.results.filter((r) => r.correct).length;
  const pct = total ? hits / total : 0;
  const stars = pct >= 0.8 ? 3 : pct >= 0.5 ? 2 : pct > 0 ? 1 : 0;
  show("result");
  $("result-stars").textContent = "⭐".repeat(stars) + "☆".repeat(3 - stars);
  $("result-title").textContent = state.hearts <= 0 ? "Acabaram as vidas!" : pct >= 0.8 ? "Arrasou!" : pct >= 0.5 ? "Muito bem!" : "Bora treinar mais!";
  $("result-score").textContent = `${hits}/${total}`;
  $("result-xp").textContent = "+" + state.xp;
  registerStudyDay(state.xp);
  if (state.libId) library.recordPlay(state.libId, hits, total);
  if (stars >= 2) { confetti(); sfx.win(); }

  const box = $("result-feedback");
  if (!currentModel()) {
    // rejogando um estudo salvo sem o modelo carregado: resumo local
    const wrong = state.results.filter((r) => !r.correct);
    box.textContent = wrong.length
      ? "Para revisar:\n" + wrong.map((r) => `• ${r.question} → ${r.answer}`).join("\n")
      : "Você acertou tudo. Mandou muito bem!";
    return;
  }
  box.textContent = "🦉 analisando seu desempenho...";
  const resumo = state.results.map((r, i) =>
    `${i + 1}. ${r.question} → ${r.correct ? "ACERTOU" : "ERROU (resposta certa: " + r.answer + ")"}`).join("\n");
  try {
    await streamText([
      { role: "system", content: "Você é um mentor de estudos motivador. Escreva em português do Brasil, em texto corrido e sem markdown." },
      { role: "user", content:
        `O aluno estudou "${state.topic}" (nível ${state.level}, modo ${state.mode}).\nResultado:\n${resumo}\n\n` +
        `Escreva um feedback curto (máx. 5 frases): elogie o que foi bem, aponte o que revisar com base nos erros e sugira um próximo passo.` },
    ], (t) => { box.textContent = t; }, 300);
  } catch (e) { box.textContent = "Não consegui gerar o feedback: " + e.message; }
}

// ---------- boot ----------
function boot() {
  renderStats();
  initBackstage();
  if (!hasWebGPU()) return show("nogpu");
  initSetup();
  initSettings();
  $("btn-next").onclick = next;
  $("btn-quit").onclick = () => { state.runId++; stopGeneration(); show("setup"); };
  $("btn-again").onclick = () => show("setup");
  document.addEventListener("keydown", (e) => {
    if (!$("screen-game").classList.contains("hidden") && !state.answered && /^[1-4]$/.test(e.key) && state.mode === "quiz") {
      document.querySelectorAll(".option")[+e.key - 1]?.click();
    }
  });
  show("setup");
}
boot();
