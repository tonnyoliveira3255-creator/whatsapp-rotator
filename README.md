
# WhatsApp Rotator (Node/Express)

Um único link que redireciona, de forma rotativa, para vários WhatsApp.

## Como usar localmente
```bash
npm install
npm start
# abra http://localhost:3000/  (vai redirecionar para um dos números)
# http://localhost:3000/links  -> lista atual de links
# http://localhost:3000/health -> ok
```

Edite os números em `links.json`.

## Deploy sugerido (Render)
- Crie um repositório no GitHub contendo estes arquivos
- No Render: New -> Web Service -> conecte o repo
  - Build Command: `npm install`
  - Start Command: `node app.js` (ou use o Procfile)
- Acesse a URL gerada e use-a nos anúncios/bio
- Para passar UTM: `https://SEU-APP.onrender.com/?utm_source=fb&utm_campaign=house`
