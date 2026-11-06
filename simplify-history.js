// =====================================================================
//  simplify-history.js — histórico do simplificador, salvo no navegador
//  (localStorage). Cada item guarda o texto original, o nível e o resultado,
//  para reabrir sem chamar o modelo de novo.
//
//  Formato: { id, text, level, result, model, createdAt }
// =====================================================================
const KEY = "studyquest_simplify_history";
const MAX_ITEMS = 30; // acima disso os mais antigos são descartados

const norm = (t) => t.replace(/\s+/g, " ").trim();
const byRecent = (a, b) => b.createdAt - a.createdAt;

function read() {
  try {
    const list = JSON.parse(localStorage.getItem(KEY) || "[]");
    return Array.isArray(list) ? list : [];
  } catch { return []; }
}

// Grava os mais recentes primeiro; se estourar a cota do navegador, descarta o mais antigo.
function write(list) {
  const copy = [...list].sort(byRecent).slice(0, MAX_ITEMS);
  while (copy.length) {
    try { localStorage.setItem(KEY, JSON.stringify(copy)); return true; }
    catch { copy.pop(); }
  }
  return false;
}

export const simplifyHistory = {
  // Mais recentes primeiro.
  list: () => read().sort(byRecent),

  // Já simplificamos este mesmo texto neste mesmo nível? (ignora diferenças de espaço/quebra de linha)
  find(text, level) {
    const n = norm(text);
    return read().find((e) => e.level === level && norm(e.text) === n) || null;
  },

  // Guarda um resultado. Se o mesmo texto+nível já existia, substitui (e sobe para o topo).
  add({ text, level, result, model }) {
    const n = norm(text);
    const list = read().filter((e) => !(e.level === level && norm(e.text) === n));
    const entry = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
      text, level, result, model, createdAt: Date.now(),
    };
    list.push(entry);
    write(list);
    return entry;
  },

  remove(id) { write(read().filter((e) => e.id !== id)); },
  clear() { try { localStorage.removeItem(KEY); } catch {} },
};
