// =====================================================================
//  llm.js — TUDO que fala com o WebLLM fica isolado aqui.
//  O resto do app só chama as funções exportadas abaixo.
// =====================================================================
import * as webllm from "https://esm.run/@mlc-ai/web-llm@0.2.79";

// Modelos disponíveis no seletor. `size` é o download aproximado (varia um pouco por versão).
// Lista completa: webllm.prebuiltAppConfig.model_list
export const MODEL_OPTIONS = [
  { id: "Qwen2.5-0.5B-Instruct-q4f16_1-MLC", name: "Qwen 2.5 · 0.5B", size: "~0.4 GB", note: "Minúsculo e rápido, mas erra bastante." },
  { id: "Llama-3.2-1B-Instruct-q4f16_1-MLC", name: "Llama 3.2 · 1B",  size: "~0.7 GB", note: "Leve. Bom ponto de partida." },
  { id: "Qwen2.5-1.5B-Instruct-q4f16_1-MLC", name: "Qwen 2.5 · 1.5B", size: "~1.0 GB", note: "Equilíbrio entre peso e qualidade." },
  { id: "Llama-3.2-3B-Instruct-q4f16_1-MLC", name: "Llama 3.2 · 3B",  size: "~1.8 GB", note: "Mais preciso; precisa de mais GPU." },
  { id: "Qwen2.5-3B-Instruct-q4f16_1-MLC",   name: "Qwen 2.5 · 3B",   size: "~2.0 GB", note: "Ótimo em português; download maior." },
  { id: "Phi-3.5-mini-instruct-q4f16_1-MLC", name: "Phi 3.5 mini",    size: "~2.3 GB", note: "O mais pesado da lista." },
];
export const DEFAULT_MODEL = "Llama-3.2-1B-Instruct-q4f16_1-MLC";

// ---------------------------------------------------------------------
// Armazenamento do modelo. Por padrão o WebLLM usa a Cache API do navegador.
// Em alguns computadores (antivírus, políticas da empresa, extensões) ela falha com
// "Cache.add() encountered a network error". Nesse caso trocamos para IndexedDB
// e lembramos a escolha.
// ---------------------------------------------------------------------
const IDB_KEY = "studyquest_idb";
let useIDB = (() => { try { return localStorage.getItem(IDB_KEY) === "1"; } catch { return false; } })();
const makeConfig = (idb) => ({ ...webllm.prebuiltAppConfig, useIndexedDBCache: idb });

// true se os arquivos do modelo já estão guardados (em qualquer um dos dois armazenamentos)
export async function isCached(id) {
  for (const idb of [false, true]) {
    try { if (await webllm.hasModelInCache(id, makeConfig(idb))) return true; } catch {}
  }
  return false;
}

let engine = null;
let engineIDB = false;
let loadedModel = null;

// Ganchos para o painel de bastidores
export const hooks = { onLog: () => {} };

export const hasWebGPU = () => !!navigator.gpu;

async function create(modelId, idb, onProgress) {
  if (engine && engineIDB === idb) {
    engine.setInitProgressCallback((p) => onProgress(p));
    await engine.reload(modelId);
  } else {
    engine = await webllm.CreateMLCEngine(modelId, {
      appConfig: makeConfig(idb),
      initProgressCallback: (p) => onProgress(p), // { progress: 0..1, text }
    });
    engineIDB = idb;
  }
}

// 1) Baixa (ou lê do cache) e compila o modelo na GPU.
export async function loadModel(modelId = DEFAULT_MODEL, onProgress = () => {}) {
  if (engine && loadedModel === modelId) return;
  try {
    await create(modelId, useIDB, onProgress);
  } catch (e) {
    if (useIDB || !/cache/i.test(String(e.message))) throw e;
    // A Cache API falhou: tenta de novo guardando em IndexedDB.
    useIDB = true;
    try { localStorage.setItem(IDB_KEY, "1"); } catch {}
    onProgress({ progress: 0, text: "A Cache API falhou; tentando de novo com IndexedDB..." });
    engine = null;
    await create(modelId, true, onProgress);
  }
  loadedModel = modelId;
}

export const currentModel = () => loadedModel;
export const stopGeneration = () => engine && engine.interruptGenerate();

// ---------------------------------------------------------------------
// 2) Gera UMA pergunta como JSON. O `response_format` com JSON Schema
//    força o modelo a devolver exatamente a estrutura que queremos —
//    é o que torna modelos pequenos utilizáveis.
// ---------------------------------------------------------------------
const SCHEMAS = {
  quiz: {
    type: "object",
    properties: {
      question:    { type: "string" },
      options:     { type: "array", items: { type: "string" }, minItems: 4, maxItems: 4 },
      correctIndex:{ type: "integer" },
      explanation: { type: "string" },
    },
    required: ["question", "options", "correctIndex", "explanation"],
  },
  flashcards: {
    type: "object",
    properties: {
      front: { type: "string" },
      back:  { type: "string" },
    },
    required: ["front", "back"],
  },
};

function buildPrompt({ mode, topic, level, context, previous, index, total }) {
  const shape = mode === "quiz"
    ? "uma pergunta de múltipla escolha com 4 alternativas curtas, o índice (0 a 3) da alternativa correta e uma explicação de 1 ou 2 frases"
    : "um flashcard com a frente (pergunta ou termo curto) e o verso (resposta clara e curta)";
  const avoid = previous.length
    ? `\nNÃO repita nem reformule estas perguntas já feitas:\n- ${previous.join("\n- ")}`
    : "";
  return [
    {
      role: "system",
      content: "Você é um professor paciente e preciso que cria material de estudo em português do Brasil. " +
               "Seja factualmente correto. Responda SOMENTE com JSON válido.",
    },
    {
      role: "user",
      content:
        `Tema: ${topic}\nNível do aluno: ${level}\n` +
        (context ? `Contexto do aluno: ${context}\n` : "") +
        `\nCrie ${shape}. Esta é a pergunta ${index + 1} de ${total}; ` +
        `cubra um aspecto diferente do tema.${avoid}` +
        (mode === "quiz"
          ? `\n\nFormato exato (JSON):\n{"question":"...","options":["A","B","C","D"],"correctIndex":0,"explanation":"..."}\n` +
            `"options" deve ter EXATAMENTE 4 textos.`
          : `\n\nFormato exato (JSON):\n{"front":"...","back":"..."}`),
    },
  ];
}

export async function generateItem(opts, attempts = 5) {
  const messages = buildPrompt(opts);
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    const t0 = performance.now();
    try {
      const res = await engine.chat.completions.create({
        messages,
        temperature: i === 0 ? 0.8 : 0.5, // nas novas tentativas, menos criatividade = formato mais estável
        max_tokens: 600, // 400 podia cortar o JSON no meio
        response_format: { type: "json_object", schema: JSON.stringify(SCHEMAS[opts.mode]) },
      });
      const raw = res.choices[0].message.content;
      hooks.onLog({ prompt: messages, output: raw, usage: res.usage, ms: performance.now() - t0 });
      return validate(opts.mode, JSON.parse(raw));
    } catch (e) {
      lastErr = e; // JSON inválido ou formato errado: tenta de novo
    }
  }
  throw lastErr;
}

// Modelos pequenos às vezes devolvem alternativas como objetos, com mais de 4 itens
// ou com nomes de campo diferentes. Aceitamos o que dá para aproveitar.
function asText(o) {
  if (typeof o === "string") return o.trim();
  if (o && typeof o === "object") return String(o.text ?? o.option ?? o.alternativa ?? Object.values(o)[0] ?? "").trim();
  return String(o ?? "").trim();
}

function validate(mode, d) {
  if (mode === "quiz") {
    const question = asText(d.question ?? d.pergunta);
    let options = d.options ?? d.alternativas ?? d.choices;
    if (options && !Array.isArray(options) && typeof options === "object") options = Object.values(options);
    options = Array.isArray(options) ? options.map(asText).filter(Boolean) : [];
    if (!question) throw new Error("quiz inválido: sem pergunta");
    if (options.length < 4) throw new Error(`quiz inválido: só ${options.length} alternativas`);
    options = options.slice(0, 4);
    const idx = Math.min(3, Math.max(0, Number(d.correctIndex ?? d.correta) || 0));
    return { question, options, correctIndex: idx, explanation: asText(d.explanation ?? d.explicacao) };
  }
  if (!d.front || !d.back) throw new Error("flashcard inválido");
  return { front: d.front, back: d.back };
}

// ---------------------------------------------------------------------
// 3) Texto livre com STREAMING (explicações e feedback final).
//    `onToken` recebe o texto acumulado a cada pedacinho gerado.
// ---------------------------------------------------------------------
export async function streamText(messages, onToken, max_tokens = 350) {
  const t0 = performance.now();
  const stream = await engine.chat.completions.create({
    messages,
    stream: true,
    stream_options: { include_usage: true },
    temperature: 0.7,
    max_tokens,
  });
  let text = "", usage = null;
  for await (const chunk of stream) {
    text += chunk.choices[0]?.delta?.content || "";
    if (chunk.usage) usage = chunk.usage;
    onToken(text);
  }
  hooks.onLog({ prompt: messages, output: text, usage, ms: performance.now() - t0 });
  return text;
}
