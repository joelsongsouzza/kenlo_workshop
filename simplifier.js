// =====================================================================
//  simplifier.js — tela do assistente de simplificação de texto.
//  A IA fica no llm.js (simplifyText); o histórico, no simplify-history.js.
//  Texto já simplificado antes vem do histórico, sem chamar o modelo.
// =====================================================================
import { hasWebGPU, loadModel, simplifyText, stopGeneration, currentModel } from "./llm.js";
import { simplifyHistory } from "./simplify-history.js";
import { $, esc, getModel, initTheme, initSettings, initBackstage } from "./common.js";

const LEVELS = {
  crianca: { icon: "🧒", name: "Criança", hint: "Frases curtas e exemplos do dia a dia, como para uma criança de 10 anos." },
  leigo:   { icon: "🙂", name: "Leigo",   hint: "Linguagem clara para quem não é da área: sem jargão, com todas as informações importantes." },
  resumo:  { icon: "⚡", name: "Resumo",  hint: "Só o essencial, em até 3 frases." },
};

// Textos prontos para testar rápido (ótimos para a apresentação)
const SAMPLES = [
  { label: "⚖️ Contrato", text: "A parte contratante obriga-se a efetuar o pagamento da contraprestação pecuniária ajustada até o quinto dia útil do mês subsequente ao da prestação dos serviços, sob pena de incidência de multa moratória de 2% (dois por cento) sobre o valor devido, acrescida de juros de mora de 1% (um por cento) ao mês e correção monetária pelo IPCA." },
  { label: "🩺 Saúde", text: "A hipertensão arterial sistêmica é uma condição clínica multifatorial caracterizada por níveis elevados e sustentados de pressão arterial. Frequentemente associa-se a alterações funcionais e estruturais dos órgãos-alvo, como coração, encéfalo, rins e vasos sanguíneos, aumentando o risco de eventos cardiovasculares fatais e não fatais." },
  { label: "🐳 Tecnologia", text: "Containers são unidades leves de software que empacotam o código e todas as suas dependências, permitindo que uma aplicação execute de forma rápida e confiável em diferentes ambientes computacionais. Diferentemente das máquinas virtuais, os containers compartilham o kernel do sistema operacional hospedeiro, o que reduz o consumo de recursos e o tempo de inicialização." },
];

let level = "leigo";
let busy = false;       // gerando agora
let stopped = false;    // usuário clicou em Parar

// ---------- entrada ----------
function setLevel(key) {
  level = key;
  [...$("sim-level").children].forEach((b) => b.classList.toggle("active", b.dataset.v === key));
  $("sim-level-hint").textContent = LEVELS[key].hint;
}

function renderCount() {
  $("sim-text").style.borderColor = ""; // limpa o aviso vermelho de "texto vazio"
  $("sim-count").textContent = `${$("sim-text").value.length} / ${$("sim-text").maxLength}`;
}

function initInput() {
  SAMPLES.forEach((s) => {
    const b = document.createElement("button");
    b.textContent = s.label;
    b.onclick = () => { if (busy) return; $("sim-text").value = s.text; renderCount(); };
    $("sim-samples").appendChild(b);
  });
  $("sim-level").onclick = (e) => {
    const b = e.target.closest("button");
    if (b && !busy) setLevel(b.dataset.v);
  };
  $("sim-text").oninput = renderCount;
  $("btn-simplify").onclick = onSimplify;
  $("btn-regen").onclick = () => { const t = currentText(); if (t && !busy) generate(t, level); };
  $("btn-copy").onclick = copyResult;
  $("btn-stop").onclick = () => { stopped = true; stopGeneration(); };
  $("btn-clear-history").onclick = () => {
    if (!busy && confirm("Apagar todo o histórico de simplificações?")) { simplifyHistory.clear(); renderHistory(); }
  };
  setLevel(level);
  renderCount();
}

const currentText = () => $("sim-text").value.trim();

function onSimplify() {
  if (busy) return;
  const text = currentText();
  if (!text) { $("sim-text").focus(); $("sim-text").style.borderColor = "var(--red)"; return; }
  // já simplificamos este texto neste nível? Reaproveita, sem gastar IA.
  const hit = simplifyHistory.find(text, level);
  if (hit) return view(hit, "📚 do histórico · sem usar a IA");
  generate(text, level);
}

function setBusy(on) {
  busy = on;
  $("btn-simplify").disabled = on;
  $("btn-regen").disabled = on;
  $("btn-simplify").textContent = on ? "SIMPLIFICANDO..." : "SIMPLIFICAR";
  document.querySelectorAll("#sim-history-list button").forEach((b) => { b.disabled = on; });
}

// ---------- resultado ----------
function showResultCard(badge) {
  $("sim-result").classList.remove("hidden");
  $("sim-badge").textContent = badge;
  $("sim-error").classList.add("hidden");
  $("sim-loading").classList.add("hidden");
  $("btn-stop").classList.add("hidden");
}

// Mostra um resultado salvo (sem chamar o modelo)
function view(entry, badge) {
  $("sim-text").value = entry.text;
  renderCount();
  setLevel(entry.level);
  showResultCard(badge);
  $("sim-out").textContent = entry.result;
  $("btn-copy").disabled = false;
  $("sim-result").scrollIntoView({ behavior: "smooth", block: "start" });
}

async function generate(text, lvl) {
  setBusy(true);
  stopped = false;
  showResultCard("⏳ gerando...");
  $("sim-out").textContent = "";
  $("btn-copy").disabled = true;
  try {
    if (!hasWebGPU()) throw new Error("seu navegador não suporta WebGPU. Abra no Chrome ou Edge atualizados, em um computador.");
    const modelId = getModel();
    if (currentModel() !== modelId) {
      $("sim-loading").classList.remove("hidden");
      $("sim-loading-bar").style.width = "0%";
      await loadModel(modelId, (p) => {
        $("sim-loading-bar").style.width = Math.round(p.progress * 100) + "%";
        $("sim-loading-detail").textContent = p.text;
      });
      $("sim-loading").classList.add("hidden");
    }
    $("bs-model").textContent = currentModel();
    $("sim-badge").textContent = "✍️ escrevendo...";
    $("btn-stop").classList.remove("hidden");
    $("sim-result").scrollIntoView({ behavior: "smooth", block: "nearest" });

    const t0 = performance.now();
    const raw = await simplifyText(text, lvl, (t) => { $("sim-out").textContent = t; });
    const result = raw.trim();
    if (stopped) {
      $("sim-badge").textContent = "⏹ interrompido · não salvo";
    } else if (!result) {
      throw new Error("o modelo não devolveu nenhum texto. Tente de novo.");
    } else {
      simplifyHistory.add({ text, level: lvl, result, model: currentModel() });
      renderHistory();
      $("sim-out").textContent = result;
      $("sim-badge").textContent = `✨ gerado agora · ${((performance.now() - t0) / 1000).toFixed(1)} s · salvo no histórico`;
    }
    $("btn-copy").disabled = !$("sim-out").textContent;
  } catch (e) {
    $("sim-loading").classList.add("hidden");
    $("sim-badge").textContent = "";
    $("sim-error").textContent = "Não consegui simplificar: " + (e.message || e);
    $("sim-error").classList.remove("hidden");
  } finally {
    $("btn-stop").classList.add("hidden");
    setBusy(false);
  }
}

async function copyResult() {
  const text = $("sim-out").textContent;
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // contexto sem permissão de clipboard: copia pelo método antigo
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand("copy"); } catch {}
    ta.remove();
  }
  const btn = $("btn-copy");
  btn.textContent = "✅ Copiado!";
  setTimeout(() => { btn.textContent = "📋 Copiar"; }, 1500);
}

// ---------- histórico ----------
const clip = (t, n) => (t.length > n ? t.slice(0, n).trimEnd() + "…" : t);

function renderHistory() {
  const items = simplifyHistory.list();
  $("sim-history").classList.toggle("hidden", items.length === 0);
  const list = $("sim-history-list");
  list.innerHTML = "";
  items.forEach((e) => {
    const lv = LEVELS[e.level] || LEVELS.leigo;
    const meta = `${lv.icon} ${lv.name} · ${new Date(e.createdAt).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" })}`;
    const row = document.createElement("div");
    row.className = "lib-item";
    row.innerHTML = `<span class="grow">${esc(clip(e.text, 80))}<small>${esc(meta)}</small><small>→ ${esc(clip(e.result, 90))}</small></span>
      <button class="btn btn-green hist-open">Abrir</button>
      <button class="icon-btn hist-del" title="Excluir" aria-label="Excluir">🗑</button>`;
    row.querySelector(".hist-open").onclick = () => { if (!busy) view(e, "📚 do histórico · sem usar a IA"); };
    row.querySelector(".hist-del").onclick = () => {
      if (!busy && confirm("Excluir este item do histórico?")) { simplifyHistory.remove(e.id); renderHistory(); }
    };
    list.appendChild(row);
  });
}

// ---------- boot ----------
initTheme();
initBackstage();
initSettings();
initInput();
renderHistory();
