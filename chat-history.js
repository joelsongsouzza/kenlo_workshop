// =====================================================================
//  chat-history.js — histórico das conversas do chat com documentos,
//  salvo no navegador (localStorage). Guarda SÓ o nome do documento e as
//  perguntas e respostas: o conteúdo do documento e os trechos recuperados
//  não são salvos aqui.
//
//  Formato: { id, docId, docName, messages: [{ q, a }], createdAt, updatedAt }
//  (`docId` só serve para continuar a conversa se o documento ainda estiver
//  indexado neste navegador.)
// =====================================================================
const KEY = "studyquest_doc_chats";
const MAX_CHATS = 30;      // acima disso as mais antigas são descartadas
const MAX_MESSAGES = 40;   // perguntas por conversa

function read() {
  try {
    const list = JSON.parse(localStorage.getItem(KEY) || "[]");
    return Array.isArray(list) ? list : [];
  } catch { return []; }
}

const byRecent = (a, b) => b.updatedAt - a.updatedAt;

// Grava as mais recentes primeiro; se estourar a cota do navegador, descarta a mais antiga.
function write(list) {
  const copy = [...list].sort(byRecent).slice(0, MAX_CHATS);
  while (copy.length) {
    try { localStorage.setItem(KEY, JSON.stringify(copy)); return true; }
    catch { copy.pop(); }
  }
  try { localStorage.removeItem(KEY); } catch {}
  return false;
}

export const chatHistory = {
  newId: () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7),

  // Mais recentes primeiro.
  list: () => read().sort(byRecent),

  get: (id) => read().find((c) => c.id === id) || null,

  // Cria ou atualiza a conversa (chamado a cada resposta completa).
  save({ id, docId, docName, messages }) {
    if (!messages.length) return;
    const list = read();
    const i = list.findIndex((c) => c.id === id);
    const prev = i >= 0 ? list[i] : { createdAt: Date.now() };
    // copia só q/a: nada além disso vai para o armazenamento
    const entry = {
      id, docId, docName, createdAt: prev.createdAt, updatedAt: Date.now(),
      messages: messages.slice(-MAX_MESSAGES).map((m) => ({ q: m.q, a: m.a })),
    };
    if (i >= 0) list[i] = entry; else list.push(entry);
    write(list);
  },

  remove(id) { write(read().filter((c) => c.id !== id)); },
  clear() { try { localStorage.removeItem(KEY); } catch {} },
};
