// =====================================================================
//  llm.js — TUDO que fala com o WebLLM fica isolado aqui.
//  O resto do app só chama as funções exportadas abaixo.
// =====================================================================
import * as webllm from "https://esm.run/@mlc-ai/web-llm@0.2.79";

// Modelos pequenos o bastante para rodar em notebook. Troque à vontade:
// lista completa em webllm.prebuiltAppConfig.model_list
export const MODELS = {
  leve:  "Llama-3.2-1B-Instruct-q4f16_1-MLC",
  bom:   "Qwen2.5-3B-Instruct-q4f16_1-MLC",
};
export const DEFAULT_MODEL = MODELS.leve; // ~700 MB; use MODELS.bom (~2 GB) se a máquina aguentar

let engine = null;
let loadedModel = null;

// Ganchos para o painel de bastidores
export const hooks = { onLog: () => {} };

export const hasWebGPU = () => !!navigator.gpu;

// 1) Baixa (ou lê do cache) e compila o modelo na GPU.
export async function loadModel(modelId = DEFAULT_MODEL, onProgress = () => {}) {
  if (engine && loadedModel === modelId) return;
  if (engine) {
    engine.setInitProgressCallback((p) => onProgress(p));
    await engine.reload(modelId);
  } else {
    engine = await webllm.CreateMLCEngine(modelId, {
      initProgressCallback: (p) => onProgress(p), // { progress: 0..1, text }
    });
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
        `cubra um aspecto diferente do tema.${avoid}`,
    },
  ];
}

export async function generateItem(opts, attempts = 3) {
  const messages = buildPrompt(opts);
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    const t0 = performance.now();
    try {
      const res = await engine.chat.completions.create({
        messages,
        temperature: 0.8,
        max_tokens: 400,
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

function validate(mode, d) {
  if (mode === "quiz") {
    if (!d.question || !Array.isArray(d.options) || d.options.length !== 4) throw new Error("quiz inválido");
    const idx = Math.min(3, Math.max(0, Number(d.correctIndex) || 0));
    return { question: d.question, options: d.options.map(String), correctIndex: idx, explanation: d.explanation || "" };
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
