// =====================================================================
//  docstore.js — documentos já indexados, guardados no IndexedDB do
//  navegador. Guardamos os trechos e os vetores (embeddings): reabrir um
//  documento é instantâneo, sem ler o PDF nem gerar embeddings de novo.
//
//  Duas "tabelas": `meta` (leve, usada na lista) e `data` (trechos + vetores).
//    meta: { id, name, kind, size, pages, chunks, truncated, model, createdAt, lastOpenedAt }
//    data: { id, chunks: [{ text, loc }], vectors: Float32Array(n * dim), dim }
// =====================================================================
const DB_NAME = "studyquest_docs";
const MAX_DOCS = 20; // acima disso os menos usados são descartados

let dbP = null;
function db() {
  if (!dbP) {
    dbP = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore("meta", { keyPath: "id" });
        req.result.createObjectStore("data", { keyPath: "id" });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    dbP.catch(() => { dbP = null; });
  }
  return dbP;
}

// Executa uma transação e espera ela TERMINAR (não só o pedido). `fn` recebe a transação
// e pode devolver uma promessa (via wrap) com o valor a retornar.
function tx(stores, mode, fn) {
  return db().then((d) => new Promise((resolve, reject) => {
    const t = d.transaction(stores, mode);
    const out = fn(t);
    t.oncomplete = () => resolve(out);
    t.onerror = t.onabort = () => reject(t.error || new Error("falha no IndexedDB"));
  }));
}
const wrap = (req) => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });

export const docStore = {
  async list() {
    const all = await tx(["meta"], "readonly", (t) => wrap(t.objectStore("meta").getAll()));
    return (all || []).sort((a, b) => (b.lastOpenedAt || b.createdAt) - (a.lastOpenedAt || a.createdAt));
  },

  async has(id) {
    return !!(await tx(["meta"], "readonly", (t) => wrap(t.objectStore("meta").get(id))));
  },

  // { meta, chunks, vectors, dim } ou null
  async get(id) {
    const [meta, data] = await Promise.all([
      tx(["meta"], "readonly", (t) => wrap(t.objectStore("meta").get(id))),
      tx(["data"], "readonly", (t) => wrap(t.objectStore("data").get(id))),
    ]);
    return meta && data ? { meta, chunks: data.chunks, vectors: data.vectors, dim: data.dim } : null;
  },

  async put(meta, data) {
    await tx(["meta", "data"], "readwrite", (t) => {
      t.objectStore("meta").put(meta);
      t.objectStore("data").put({ id: meta.id, ...data });
    });
    // mantém no máximo MAX_DOCS: remove os menos recentes
    const metas = await this.list();
    for (const old of metas.slice(MAX_DOCS)) await this.remove(old.id);
  },

  async touch(id) {
    await tx(["meta"], "readwrite", (t) => {
      const store = t.objectStore("meta");
      const req = store.get(id);
      req.onsuccess = () => { if (req.result) store.put({ ...req.result, lastOpenedAt: Date.now() }); };
    });
  },

  async remove(id) {
    await tx(["meta", "data"], "readwrite", (t) => {
      t.objectStore("meta").delete(id);
      t.objectStore("data").delete(id);
    });
  },
};
