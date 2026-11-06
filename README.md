# StudyQuest 🦉

Quiz e flashcards gerados por IA **rodando 100% no navegador** com [WebLLM](https://github.com/mlc-ai/web-llm).
Sem backend, sem API key. HTML + JS puro, sem build.

## Rodar localmente
```bash
python3 -m http.server 8000   # ou qualquer servidor estático
```
Abra http://localhost:8000 no **Chrome/Edge** (precisa de WebGPU).

## Deploy
Arraste esta pasta no Netlify (ou `netlify deploy --prod --dir .`).

## Arquivos
- `llm.js` — tudo do WebLLM (carregar modelo, JSON com schema, streaming). Comece por aqui.
- `app.js` — interface e gamificação (vidas, XP, combo, streak).
- `style.css`, `index.html` — visual.

## Dicas para a apresentação
- Abra o site antes e gere um quiz uma vez: o modelo fica em cache e abre rápido depois.
- Botão **Bastidores** mostra modelo, tokens/s, prompt e resposta crua.
- Para trocar o modelo, clique na engrenagem ⚙️ no topo (mostra o tamanho do download de cada um e quais já estão em cache).
