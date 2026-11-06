// =====================================================================
//  embed.js — embeddings LOCAIS com Transformers.js (ONNX + WebAssembly).
//  Transforma texto em vetores para a busca por significado do chat com
//  documentos. Nada é enviado a servidor: o navegador só baixa o modelo
//  (uma vez, depois fica em cache).
//
//  Modelo: multilingual-e5-small (quantizado, ~120 MB, 384 dimensões).
//  É multilíngue (funciona bem em português) e exige os prefixos
//  "query: " (pergunta) e "passage: " (trecho do documento).
// =====================================================================
const LIB_URL = "https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2";

export const EMBED_MODEL = "Xenova/multilingual-e5-small";
export const EMBED_DIM = 384;

let extractor = null;
let loading = null;

export const embedderReady = () => !!extractor;

// Baixa (ou lê do cache) e prepara o modelo. `onProgress(fração 0..1, texto)`.
export function loadEmbedder(onProgress = () => {}) {
  if (extractor) return Promise.resolve();
  if (loading) return loading;
  loading = (async () => {
    // import dinâmico: se o CDN cair, só esta tela falha, não a página inteira
    const { pipeline, env } = await import(LIB_URL);
    env.allowLocalModels = false;
    const files = {}; // progresso por arquivo -> um único progresso total
    extractor = await pipeline("feature-extraction", EMBED_MODEL, {
      quantized: true,
      progress_callback: (p) => {
        if (p.status === "progress" && p.file) {
          files[p.file] = { loaded: p.loaded, total: p.total };
          const all = Object.values(files);
          const loaded = all.reduce((a, f) => a + f.loaded, 0);
          const total = all.reduce((a, f) => a + f.total, 0);
          onProgress(total ? loaded / total : 0, `${(loaded / 1e6).toFixed(0)} de ${(total / 1e6).toFixed(0)} MB`);
        } else if (p.status === "ready") {
          onProgress(1, "pronto");
        }
      },
    });
  })();
  loading.catch(() => { loading = null; extractor = null; });
  return loading;
}

const tick = () => new Promise((r) => setTimeout(r, 0));

// Gera um vetor (normalizado) por texto. `kind`: "passage" (trechos) ou "query" (pergunta).
// Processa em lotes pequenos e devolve o controle ao navegador entre eles,
// para a página não congelar e a barra de progresso andar.
export async function embed(texts, kind = "passage", onProgress = () => {}, batch = 8) {
  await loadEmbedder();
  const out = [];
  for (let i = 0; i < texts.length; i += batch) {
    const part = texts.slice(i, i + batch).map((t) => `${kind}: ${t}`);
    const res = await extractor(part, { pooling: "mean", normalize: true });
    const dim = res.dims[1];
    for (let j = 0; j < part.length; j++) out.push(Float32Array.from(res.data.subarray(j * dim, (j + 1) * dim)));
    onProgress(Math.min(i + batch, texts.length), texts.length);
    await tick();
  }
  return out;
}
