# StudyQuest 🦉

Quiz, flashcards, um assistente de simplificação de texto e um chat com seus próprios documentos (RAG), tudo com IA **rodando 100% no navegador** com [WebLLM](https://github.com/mlc-ai/web-llm).
Sem backend, sem API key. HTML + JS puro, sem build.

## Rodar localmente
```bash
python3 -m http.server 8000   # ou qualquer servidor estático
```
Abra http://localhost:8000 no **Chrome/Edge** (precisa de WebGPU). O quiz fica em `index.html`, o simplificador em `simplifier.html` e o chat com documentos em `docs.html` (links na navbar).

## Deploy
Arraste esta pasta no Netlify (ou `netlify deploy --prod --dir .`).

## Arquivos
- `llm.js` — tudo do WebLLM (carregar modelo, JSON com schema, streaming). Comece por aqui.
- `app.js` — interface e gamificação (vidas, XP, combo, streak).
- `wiki.js` — busca o resumo do tema na Wikipédia (pt) e o entrega ao modelo como texto de referência: modelos pequenos não sabem fatos, mas fazem boas perguntas a partir de um texto pronto. Só usa o artigo se o título combinar com o tema; senão avisa e segue sem. Dá para desligar na tela inicial.
- `library.js` — biblioteca de estudos salvos no `localStorage` (até 50). Toda pergunta gerada é salva na hora e pode ser rejogada pela tela inicial, sem modelo e sem esperar a IA.
- `simplifier.html`, `simplifier.js` — tela do **assistente de simplificação**: cole um texto e escolha *Criança*, *Leigo* ou *Resumo*. A resposta chega em streaming; o prompt está em `simplifyText` no `llm.js`.
- `simplify-history.js` — histórico do simplificador no `localStorage` (até 30). Pedir o mesmo texto no mesmo nível devolve o resultado salvo na hora, sem modelo; **Gerar de novo** força uma nova geração.
- `docs.html`, `docs.js` — **chat com documentos (RAG)**: carregue um PDF, Markdown ou TXT e pergunte. A resposta cita os trechos usados ([1], [2]), que podem ser abertos com a pontuação de similaridade.
- `rag.js` — lê o arquivo (PDF com [pdf.js](https://mozilla.github.io/pdf.js/); Markdown por seção), divide em trechos de ~900 caracteres e busca os mais parecidos com a pergunta por cosseno.
- `embed.js` — embeddings **locais** com [Transformers.js](https://github.com/xenova/transformers.js) (`multilingual-e5-small`, ~120 MB, roda em WebAssembly). É a única parte que não usa o WebLLM.
- `docstore.js` — índice dos documentos (trechos + vetores) no IndexedDB. Reabrir um documento é instantâneo; subir o mesmo arquivo de novo reaproveita o índice (identificado por SHA-256).
- `chat-history.js` — histórico das conversas do chat com documentos no `localStorage` (até 30 conversas). Salva **só o nome do documento e as perguntas e respostas**, nunca o conteúdo do documento nem os trechos recuperados. Se o documento ainda estiver indexado dá para **Continuar** a conversa; senão ela abre em **Ver** (só leitura).
- `common.js` — o que as duas telas compartilham: tema, escolha do modelo (a mesma nas duas) e Bastidores.
- `style.css`, `index.html` — visual.

## Privacidade do chat com documentos
O arquivo, os trechos, os vetores e as perguntas **nunca saem do navegador**. A rede só é usada para baixar bibliotecas (jsDelivr) e modelos (Hugging Face), uma vez cada. Para provar: abra o DevTools → Rede, carregue um documento e pergunte: só aparecem `GET`s de download, nenhum envio.
As conversas salvas têm só nome do documento, perguntas e respostas (as respostas podem citar trechos do texto). Ficam no `localStorage` deste navegador, e dá para apagá-las uma a uma, ou todas, na tela.
Limites: PDFs até 25 MB e 300 páginas, até 800 trechos; PDF escaneado (só imagem) não tem texto para ler, e não há OCR.

## Dicas para a apresentação
- Abra o site antes e gere um quiz uma vez: o modelo fica em cache e abre rápido depois.
- Para o chat com documentos, indexe antes o arquivo da demo (ou use **📘 Testar com o README**): o modelo de embeddings fica em cache e o documento fica na lista **Meus documentos**, abrindo na hora. Indexar um PDF de 60 páginas leva cerca de 40 s na primeira vez.
- Para o simplificador, rode os textos de exemplo (⚖️ 🩺 🐳) antes da apresentação: ficam no **Histórico** e abrem instantaneamente, sem esperar a IA.
- Botão **Bastidores** mostra modelo, tokens/s, prompt e resposta crua.
- Para trocar o modelo, clique na engrenagem ⚙️ no topo (mostra o tamanho do download de cada um e quais já estão em cache).
