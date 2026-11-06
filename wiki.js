// =====================================================================
//  wiki.js — busca um resumo do tema na Wikipédia (pt) para servir de
//  "base de fatos" ao modelo. Modelos pequenos não sabem fatos, mas
//  conseguem fazer perguntas a partir de um texto que recebem pronto.
//  A API da Wikipédia aceita chamadas direto do navegador (origin=*).
// =====================================================================

const API = "https://pt.wikipedia.org/w/api.php";

// Devolve { title, url, text } ou null (sem rede, sem resultado, página de desambiguação...).
export async function fetchFacts(topic, { timeoutMs = 7000, maxChars = 1200 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const params = new URLSearchParams({
      action: "query", format: "json", origin: "*", redirects: "1",
      generator: "search", gsrsearch: topic, gsrlimit: "1",
      prop: "extracts|info", exintro: "1", explaintext: "1", exchars: String(maxChars), inprop: "url",
    });
    // A Wikimedia pede que clientes se identifiquem (o navegador não deixa trocar o User-Agent)
    const res = await fetch(`${API}?${params}`, {
      signal: ctrl.signal,
      headers: { "Api-User-Agent": "StudyQuest/1.0 (https://github.com/joelsongsouzza/kenlo_workshop)" },
    });
    if (!res.ok) return null;
    const data = await res.json();
    const page = Object.values(data.query?.pages ?? {})[0];
    return pageToFacts(page, topic);
  } catch {
    return null; // qualquer falha: o app segue só com o conhecimento do modelo
  } finally {
    clearTimeout(timer);
  }
}

// Radicais (5 letras, sem acento) das palavras com 4+ letras: "Saudações"/"Saudação" -> "saudac"
const stems = (t) => new Set(
  t.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/\(.*?\)/g, " ").split(/[^a-z0-9]+/).filter((w) => w.length >= 4).map((w) => w.slice(0, 5)),
);
const subset = (a, b) => a.size > 0 && [...a].every((x) => b.has(x));

// O artigo achado precisa ser sobre o tema: o título deve estar contido no tema ou vice-versa.
// Sem isso, "Saudações em inglês" traria o artigo "Saudação de água" e pioraria o quiz.
export function isRelevant(title, topic) {
  const a = stems(title), b = stems(topic);
  return subset(a, b) || subset(b, a);
}

export function pageToFacts(page, topic) {
  const text = (page?.extract ?? "").replace(/\s+\n/g, "\n").trim();
  if (!page || text.length < 200) return null; // curto demais para servir de base
  // "X pode referir-se a:" = desambiguação, não serve como base de fatos
  if (/pode referir-se a|pode significar|pode se referir a/i.test(text.slice(0, 300))) return null;
  if (!isRelevant(page.title, topic)) return null;
  return { title: page.title, url: page.fullurl, text };
}
