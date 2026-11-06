# StudyQuest 🦉

Quiz, flashcards e um assistente de simplificação de texto gerados por IA **rodando 100% no navegador** com [WebLLM](https://github.com/mlc-ai/web-llm).
Sem backend, sem API key. HTML + JS puro, sem build.

## Rodar localmente
```bash
python3 -m http.server 8000   # ou qualquer servidor estático
```
Abra http://localhost:8000 no **Chrome/Edge** (precisa de WebGPU). O quiz fica em `index.html` e o simplificador em `simplifier.html` (link **✍️ Simplificar** na navbar).

## Deploy
Arraste esta pasta no Netlify (ou `netlify deploy --prod --dir .`).

## Arquivos
- `llm.js` — tudo do WebLLM (carregar modelo, JSON com schema, streaming). Comece por aqui.
- `app.js` — interface e gamificação (vidas, XP, combo, streak).
- `wiki.js` — busca o resumo do tema na Wikipédia (pt) e o entrega ao modelo como texto de referência: modelos pequenos não sabem fatos, mas fazem boas perguntas a partir de um texto pronto. Só usa o artigo se o título combinar com o tema; senão avisa e segue sem. Dá para desligar na tela inicial.
- `library.js` — biblioteca de estudos salvos no `localStorage` (até 50). Toda pergunta gerada é salva na hora e pode ser rejogada pela tela inicial, sem modelo e sem esperar a IA.
- `simplifier.html`, `simplifier.js` — tela do **assistente de simplificação**: cole um texto e escolha *Criança*, *Leigo* ou *Resumo*. A resposta chega em streaming; o prompt está em `simplifyText` no `llm.js`.
- `simplify-history.js` — histórico do simplificador no `localStorage` (até 30). Pedir o mesmo texto no mesmo nível devolve o resultado salvo na hora, sem modelo; **Gerar de novo** força uma nova geração.
- `common.js` — o que as duas telas compartilham: tema, escolha do modelo (a mesma nas duas) e Bastidores.
- `style.css`, `index.html` — visual.

## Dicas para a apresentação
- Abra o site antes e gere um quiz uma vez: o modelo fica em cache e abre rápido depois.
- Para o simplificador, rode os textos de exemplo (⚖️ 🩺 🐳) antes da apresentação: ficam no **Histórico** e abrem instantaneamente, sem esperar a IA.
- Botão **Bastidores** mostra modelo, tokens/s, prompt e resposta crua.
- Para trocar o modelo, clique na engrenagem ⚙️ no topo (mostra o tamanho do download de cada um e quais já estão em cache).
