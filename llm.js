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
      question:      { type: "string" },
      correctAnswer: { type: "string" },
      wrongAnswers:  { type: "array", items: { type: "string" }, minItems: 3, maxItems: 3 },
      explanation:   { type: "string" },
    },
    required: ["question", "correctAnswer", "wrongAnswers", "explanation"],
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

// Divide o texto em frases e entrega a cada pergunta um trecho DIFERENTE. Só dizer "cubra outro
// aspecto" não basta: modelo pequeno com o mesmo texto repete a mesma pergunta.
function focusFor(facts, index, total) {
  const sentences = facts.text.split(/(?<=[.!?])\s+/).map((x) => x.trim()).filter((x) => x.length > 30);
  if (sentences.length < 2) return "";
  const per = Math.max(2, Math.floor(sentences.length / total));
  const start = (index * per) % sentences.length;
  return Array.from({ length: Math.min(per, sentences.length) }, (_, k) => sentences[(start + k) % sentences.length]).join(" ");
}

function buildPrompt({ mode, topic, level, context, facts, previous, index, total }) {
  const focus = facts ? focusFor(facts, index, total) : "";
  const shape = mode === "quiz"
    ? "uma pergunta de múltipla escolha: a resposta correta (curta, até 6 palavras), exatamente 3 respostas ERRADAS mas plausíveis (também curtas, diferentes da correta) e uma explicação de UMA frase curta (até 20 palavras) que justifique a resposta correta"
    : "um flashcard com a frente (pergunta ou termo curto) e o verso (resposta clara e curta)";
  const avoid = previous.length
    ? `\nNÃO repita nem reformule estas perguntas já feitas:\n- ${previous.join("\n- ")}`
    : "";
  return [
    {
      role: "system",
      content: "Você é um professor paciente e preciso que cria material de estudo em português do Brasil. " +
               "Seja factualmente correto. Responda SOMENTE com JSON válido." +
               (facts ? " Use SOMENTE as informações do texto de referência; nunca acrescente fatos de fora dele." : ""),
    },
    {
      role: "user",
      content:
        `Tema: ${topic}\nNível do aluno: ${level}\n` +
        (context ? `Contexto do aluno: ${context}\n` : "") +
        (facts ? `\nTexto de referência (Wikipédia, "${facts.title}"):\n"""\n${facts.text}\n"""\n` : "") +
        `\nCrie ${shape}. Esta é a pergunta ${index + 1} de ${total}; ` +
        `cubra um aspecto diferente do tema.` +
        (focus ? `\nFaça a pergunta SOBRE este trecho do texto e responda com o que ele diz: "${focus}"` : "") +
        avoid +
        (mode === "quiz"
          ? `\n\nFormato exato (JSON):\n{"question":"...","correctAnswer":"...","wrongAnswers":["...","...","..."],"explanation":"..."}\n` +
            `"wrongAnswers" deve ter EXATAMENTE 3 textos, nenhum igual a "correctAnswer".\n` +
            `Regras: a pergunta deve ser clara, completa e ter UMA única resposta correta; ` +
            `as erradas devem ser do mesmo tipo da correta (se a correta é uma cidade, as erradas também são cidades). ` +
            `Se não tiver certeza sobre o tema, faça uma pergunta básica e conhecida, nunca invente fatos. ` +
            `Não pergunte sobre etimologia nem "origem da palavra"; prefira Quem, Onde, Quando ou O que.\n` +
            `Exemplo (tema "Geografia"):\n` +
            `{"question":"Qual é a capital da França?","correctAnswer":"Paris","wrongAnswers":["Londres","Madri","Roma"],"explanation":"Paris é a capital e maior cidade da França."}`
          : `\n\nFormato exato (JSON):\n{"front":"...","back":"..."}`),
    },
  ];
}

// 3 tentativas: em GPU lenta cada uma custa minutos, melhor mostrar o erro logo do que girar 5x.
export async function generateItem(opts, attempts = 3) {
  const base = buildPrompt(opts);
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    // nas novas tentativas, diz ao modelo o que deu errado na anterior
    const messages = lastErr
      ? [...base.slice(0, -1), { ...base[base.length - 1], content: base[base.length - 1].content + `\n\nATENÇÃO: a resposta anterior foi rejeitada (${lastErr.message}). Corrija.` }]
      : base;
    const t0 = performance.now();
    let raw = "", usage = null;
    try {
      const res = await engine.chat.completions.create({
        messages,
        // fatos: baixa = menos invenção. Se a falha foi repetição, sobe para variar; se foi formato, desce.
        temperature: /repetiu/.test(lastErr?.message ?? "") ? 0.9 : i === 0 ? 0.5 : 0.3,
        max_tokens: 400, // com alternativas/explicação curtas o JSON cabe; menos tokens = mais rápido
        response_format: { type: "json_object", schema: JSON.stringify(SCHEMAS[opts.mode]) },
      });
      raw = res.choices[0].message.content;
      usage = res.usage;
      // última tentativa: aceita quiz com só 2 erradas distintas (3 opções) em vez de falhar de vez
      const item = validate(opts.mode, JSON.parse(raw), i === attempts - 1);
      if (isRepeat(item.question ?? item.front, opts.previous)) throw new Error("repetiu uma pergunta já feita; escolha OUTRO trecho/aspecto");
      hooks.onLog({ prompt: messages, output: raw, usage, ms: performance.now() - t0, attempt: i + 1, attempts });
      return item;
    } catch (e) {
      lastErr = e; // JSON inválido ou formato errado: tenta de novo
      // registra a tentativa que falhou, para aparecer nos Bastidores
      hooks.onLog({ prompt: messages, output: raw, usage, ms: performance.now() - t0, attempt: i + 1, attempts, error: e.message });
    }
  }
  throw lastErr;
}

// Mesma pergunta/frente de antes (igual, uma contida na outra, ou quase as mesmas palavras)?
const words = (t) => new Set(norm(t).normalize("NFD").replace(/[\u0300-\u036f]/g, "").split(/[^a-z0-9]+/).filter((w) => w.length > 3));
export function isRepeat(text, previous) {
  const n = norm(text), a = words(text);
  return previous.some((q) => {
    const m = norm(q);
    if (!m) return false;
    if (n === m || (Math.min(n.length, m.length) >= 12 && (n.includes(m) || m.includes(n)))) return true;
    const b = words(q), common = [...a].filter((w) => b.has(w)).length;
    return Math.min(a.size, b.size) > 0 && common / Math.min(a.size, b.size) >= 0.7;
  });
}

// Modelos pequenos às vezes devolvem alternativas como objetos, com mais de 4 itens
// ou com nomes de campo diferentes. Aceitamos o que dá para aproveitar.
function asText(o) {
  if (typeof o === "string") return o.trim();
  if (o && typeof o === "object") return String(o.text ?? o.option ?? o.alternativa ?? Object.values(o)[0] ?? "").trim();
  return String(o ?? "").trim();
}

const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const norm = (t) => t.toLowerCase().replace(/\s+/g, " ").trim();

function validate(mode, d, lenient = false) {
  if (mode === "quiz") {
    const question = asText(d.question ?? d.pergunta);
    if (!question) throw new Error("quiz inválido: sem pergunta");
    const correct = asText(d.correctAnswer ?? d.resposta ?? d.correta);
    if (!correct) throw new Error("quiz inválido: sem resposta correta");
    let wrong = d.wrongAnswers ?? d.erradas ?? d.distractors;
    if (wrong && !Array.isArray(wrong) && typeof wrong === "object") wrong = Object.values(wrong);
    wrong = Array.isArray(wrong) ? wrong.map(asText).filter(Boolean) : [];
    // descarta erradas repetidas ou iguais à correta (senão haveria duas respostas certas)
    // também descarta variações ("Pedra" x "Pedra da fortaleza"): confundem e não testam nada
    const kept = [norm(correct)];
    wrong = wrong.filter((w) => {
      const n = norm(w);
      if (kept.some((k) => k === n || k.includes(n) || n.includes(k))) return false;
      kept.push(n);
      return true;
    });
    if (wrong.length < (lenient ? 2 : 3)) throw new Error(`quiz inválido: só ${wrong.length} alternativas erradas distintas`);
    // A posição da certa é sorteada aqui: o modelo nunca precisa "apontar" um índice.
    const options = shuffle([correct, ...wrong.slice(0, 3)]);
    return { question, options, correctIndex: options.indexOf(correct), explanation: asText(d.explanation ?? d.explicacao) };
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
