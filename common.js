// =====================================================================
//  common.js — peças compartilhadas entre as telas (quiz e simplificador):
//  atalhos de DOM, preferências no localStorage, tema, escolha do modelo
//  e painel de bastidores.
// =====================================================================
import { MODEL_OPTIONS, DEFAULT_MODEL, isCached, hooks } from "./llm.js";

export const $ = (id) => document.getElementById(id);

export function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---------- preferências simples (XP, streak, modelo escolhido) ----------
export const store = {
  get() { try { return JSON.parse(localStorage.getItem("studyquest") || "{}"); } catch { return {}; } },
  set(v) { try { localStorage.setItem("studyquest", JSON.stringify(v)); } catch {} },
};

// ---------- tema (claro/escuro) ----------
export function initTheme() {
  const btn = $("btn-theme");
  const apply = (t) => {
    document.documentElement.dataset.theme = t;
    btn.setAttribute("aria-pressed", String(t === "dark"));
  };
  apply(document.documentElement.dataset.theme || "light");
  btn.onclick = () => {
    const t = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    apply(t);
    try { localStorage.setItem("studyquest-theme", t); } catch {}
  };
}

// ---------- configurações (escolha do modelo) ----------
export function getModel() {
  const saved = store.get().model;
  return MODEL_OPTIONS.some((m) => m.id === saved) ? saved : DEFAULT_MODEL;
}
function renderModelLabel() {
  const m = MODEL_OPTIONS.find((o) => o.id === getModel());
  $("current-model-label").textContent = `${m.name} (${m.size})`;
}

let pickedModel = null;
async function openSettings() {
  pickedModel = getModel();
  $("settings").classList.remove("hidden");
  const list = $("model-list");
  const cached = await Promise.all(MODEL_OPTIONS.map((m) => isCached(m.id)));
  const draw = () => {
    list.innerHTML = "";
    MODEL_OPTIONS.forEach((m, i) => {
      const b = document.createElement("button");
      b.className = "model-item" + (m.id === pickedModel ? " active" : "");
      b.innerHTML = `<span class="grow">${esc(m.name)}${cached[i] ? '<span class="tag">já baixado</span>' : ""}<small>${esc(m.note)}</small></span><span class="size">${esc(m.size)}</span>`;
      b.onclick = () => { pickedModel = m.id; draw(); };
      list.appendChild(b);
    });
  };
  draw();
}
function closeSettings() { $("settings").classList.add("hidden"); }

export function initSettings() {
  $("btn-settings").onclick = openSettings;
  $("link-settings").onclick = (e) => { e.preventDefault(); openSettings(); };
  $("btn-close-settings").onclick = closeSettings;
  $("settings").onclick = (e) => { if (e.target.id === "settings") closeSettings(); };
  $("btn-save-settings").onclick = () => {
    const s = store.get(); s.model = pickedModel; store.set(s);
    renderModelLabel(); closeSettings();
  };
  renderModelLabel();
}

// ---------- bastidores ----------
export function initBackstage() {
  $("btn-backstage").onclick = () => $("backstage").classList.toggle("hidden");
  $("btn-close-backstage").onclick = () => $("backstage").classList.add("hidden");
  hooks.onLog = ({ prompt, output, usage, ms, attempt, attempts, error }) => {
    $("bs-prompt").textContent = prompt.map((m) => `[${m.role}]\n${m.content}`).join("\n\n");
    $("bs-output").textContent = output;
    $("bs-time").textContent = (ms / 1000).toFixed(1) + " s" +
      (attempt ? ` · tentativa ${attempt}/${attempts}` : "") +
      (error ? ` · FALHOU: ${error}` : "");
    const tps = usage?.extra?.decode_tokens_per_s;
    $("bs-speed").textContent = tps ? tps.toFixed(1) + " tokens/s" : (usage ? usage.completion_tokens + " tokens" : "—");
  };
}
