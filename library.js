// =====================================================================
//  library.js — biblioteca de estudos salvos no navegador (localStorage).
//  Cada "estudo" é um conjunto de perguntas já geradas pela IA, que pode
//  ser rejogado sem chamar o modelo de novo.
//
//  Formato de cada entrada:
//  { id, topic, context, level, mode, items[], createdAt, lastPlayedAt,
//    plays, last: { hits, total } | null }
// =====================================================================
const KEY = "studyquest_library";
const MAX_SETS = 50; // acima disso os mais antigos são descartados

function read() {
  try {
    const list = JSON.parse(localStorage.getItem(KEY) || "[]");
    return Array.isArray(list) ? list : [];
  } catch { return []; }
}

const byRecent = (a, b) => (b.lastPlayedAt || b.createdAt) - (a.lastPlayedAt || a.createdAt);

// Grava os mais recentes primeiro. Se estourar a cota do navegador,
// descarta o mais antigo e tenta de novo.
function write(list) {
  const copy = [...list].sort(byRecent).slice(0, MAX_SETS);
  while (copy.length) {
    try { localStorage.setItem(KEY, JSON.stringify(copy)); return true; }
    catch { copy.pop(); }
  }
  return false;
}

export const library = {
  newId: () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7),

  // Mais recentes primeiro.
  list: () => read().sort(byRecent),

  get: (id) => read().find((e) => e.id === id) || null,

  // Cria ou atualiza o conjunto de perguntas (chamado a cada pergunta gerada).
  // Preserva o histórico de partidas de uma entrada já existente.
  saveSet({ id, topic, context, level, mode, items }) {
    if (!items.length) return;
    const list = read();
    const i = list.findIndex((e) => e.id === id);
    const prev = i >= 0 ? list[i] : { createdAt: Date.now(), lastPlayedAt: 0, plays: 0, last: null };
    const entry = { ...prev, id, topic, context, level, mode, items };
    if (i >= 0) list[i] = entry; else list.push(entry);
    write(list);
  },

  // Registra uma partida terminada (placar e data).
  recordPlay(id, hits, total) {
    const list = read();
    const e = list.find((x) => x.id === id);
    if (!e) return;
    e.plays = (e.plays || 0) + 1;
    e.lastPlayedAt = Date.now();
    e.last = { hits, total };
    write(list);
  },

  remove(id) { write(read().filter((e) => e.id !== id)); },
};
