---
name: social-pipeline
description: Pipeline de social media do Flago (Alerta Invest) — diagnóstico de analytics, estratégia criativa com sinais Flago, geração de imagens, publicação direta em todas as plataformas, e notificação via WhatsApp com os links por zona de tempo.
---

# /social-pipeline — Flago Daily Content Pipeline

Execute quando o cron disparar com `/social-pipeline`. **Sem etapa de aprovação — publique diretamente após gerar as imagens.** Siga o CLAUDE.md desta sessão como referência autoritativa.

---

## Agente 0 — Analytics Diagnosis

```bash
node /workspace/group/scripts/analytics/meta.mjs > /workspace/group/tmp/analytics-meta.json 2>&1 &
node /workspace/group/scripts/analytics/x.mjs > /workspace/group/tmp/analytics-x.json 2>&1 &
node /workspace/group/scripts/analytics/tiktok.mjs > /workspace/group/tmp/analytics-tiktok.json 2>&1 &
node /workspace/group/scripts/analytics/youtube.mjs > /workspace/group/tmp/analytics-youtube.json 2>&1 &
node /workspace/group/scripts/analytics/reddit.mjs > /workspace/group/tmp/analytics-reddit.json 2>&1 &
wait
cat /workspace/group/tmp/analytics-*.json
```

Salve o diagnóstico consolidado em `/workspace/group/diagnostico.json`.

---

## Agente 1 — Creative Strategy

### Passo 1 — Sinais Flago

```bash
FLAGO_APENAS_ABERTOS=true FLAGO_LIMIT=50 node /workspace/group/scripts/flago.mjs
```

### Passo 2 — Determinar zona a partir do UTC atual

| UTC | Dia | Zona | Índices permitidos |
|-----|-----|------|--------------------|
| 00:00–03:59 | Seg–Sex | Early Asia | `nikkei225`, `kospi`, `asx200` |
| 04:00–07:59 | Seg–Sex | Late Asia | `hsi`, `jkse`, `klse`, `set50`, `nsei` |
| 08:00–13:59 | Seg–Sex | Europe | `ftse100`, `dax`, `cac40`, `aex`, `smi`, `omx`, `ibex35`, `jse` |
| 14:00–23:59 | Seg–Sex | Americas | `sp500`, `tsx`, `ipc`, `ibov` |
| qualquer | Sáb–Dom | Global | todos |

Filtre os sinais pela zona. Nunca use sinais de outra zona.

### Passo 3 — Escrever criativos.json

Leia `diagnostico.json`. Escolha os 5 sinais mais fortes da zona filtrada (mix bullish + bearish). Salve `/workspace/group/criativos.json`:

```json
{
  "session": "open|mid",
  "sessionLabel": "<zona + slot, e.g. Europe Open>",
  "type": "signal|promo|news",
  "adTargets": ["<country codes da zona>"],
  "assets": [
    { "ticker": "DAX", "nome": "DAX Index", "indice": "dax", "tipo": "bullish", "indicador": "MACD", "preco": 18250.0 }
  ],
  "copy": "<copy refletindo zona e sinais reais>",
  "cta": "See the signals at flago.io"
}
```

Regras: ticker sem sufixo (.L, .DE etc.), `indicador` em inglês, `tipo` apenas `"bullish"` ou `"bearish"`, `preco` null se 0 ou ausente.

### Rotation State (sessões mid)

Leia `/workspace/group/pipeline-state.json`. Se ausente, trate datas como epoch e targets como `"europe_mid"`.

1. Se `days_since(promo_last_run) >= 7` E `promo_next_target == this_session` → type=promo. Atualize: `promo_last_run=now`, flip target.
2. Senão se `days_since(news_last_run) >= 2` E `news_next_target == this_session` → type=news. Atualize: `news_last_run=now`, flip target.
3. Senão → type=signal.

Salve o estado atualizado.

---

## Agente 2 — Image Generation

```bash
TS=$(date +%s)
SESSION=$(node -e "const c=require('/workspace/group/criativos.json'); console.log(c.session)")
LABEL=$(node -e "const c=require('/workspace/group/criativos.json'); console.log(c.sessionLabel)")
TYPE=$(node -e "const c=require('/workspace/group/criativos.json'); console.log(c.type)")
ASSETS=$(node -e "const c=require('/workspace/group/criativos.json'); console.log(JSON.stringify(c.assets))")

mkdir -p /workspace/group/tmp/images

for FORMAT in square story landscape; do
  echo "{\"session\":\"$SESSION\",\"sessionLabel\":\"$LABEL\",\"type\":\"$TYPE\",\"format\":\"$FORMAT\",\"assets\":$ASSETS,\"outputPath\":\"/workspace/group/tmp/images/creative-$FORMAT-$TS.png\"}" \
    | node /workspace/group/scripts/generate-image.mjs
done

ANIM=$([ "$TYPE" = "signal" ] && echo "scan" || { [ "$TYPE" = "promo" ] && echo "breathe" || echo "flash"; })
echo "{\"imagePath\":\"/workspace/group/tmp/images/creative-story-$TS.png\",\"outputPath\":\"/workspace/group/tmp/images/creative-video-$TS.mp4\",\"duration\":15,\"animation\":\"$ANIM\"}" \
  | node /workspace/group/scripts/generate-video.mjs
```

Após gerar todos os assets, passe direto ao Agente 3.

---

## Agente 3 — Publisher (sem aprovação)

Leia `criativos.json` para obter `assets`, `sessionLabel`, `type`. Derive `$TS` do arquivo mais recente:

```bash
TS=$(ls -t /workspace/group/tmp/images/creative-square-*.png 2>/dev/null | head -1 | grep -oE '[0-9]{10}')
ASSETS=$(node -e "const c=require('/workspace/group/criativos.json'); console.log(JSON.stringify(c.assets))")
LABEL=$(node -e "const c=require('/workspace/group/criativos.json'); console.log(c.sessionLabel)")
TYPE=$(node -e "const c=require('/workspace/group/criativos.json'); console.log(c.type)")

# X / Twitter — text-only
echo "{\"assets\":$ASSETS,\"sessionLabel\":\"$LABEL\",\"type\":\"$TYPE\",\"landscapePath\":\"/workspace/group/tmp/images/creative-landscape-$TS.png\"}" \
  | node /workspace/group/scripts/publish/x.mjs

# Instagram + Facebook
echo "{\"squarePath\":\"/workspace/group/tmp/images/creative-square-$TS.png\",\"assets\":$ASSETS,\"sessionLabel\":\"$LABEL\",\"type\":\"$TYPE\"}" \
  | node /workspace/group/scripts/publish/meta.mjs

# TikTok
echo "{\"videoPath\":\"/workspace/group/tmp/images/creative-video-$TS.mp4\",\"assets\":$ASSETS,\"sessionLabel\":\"$LABEL\",\"type\":\"$TYPE\"}" \
  | node /workspace/group/scripts/publish/tiktok.mjs

# YouTube Shorts
echo "{\"videoPath\":\"/workspace/group/tmp/images/creative-video-$TS.mp4\",\"assets\":$ASSETS,\"sessionLabel\":\"$LABEL\",\"type\":\"$TYPE\"}" \
  | node /workspace/group/scripts/publish/youtube.mjs

# LinkedIn
echo "{\"squarePath\":\"/workspace/group/tmp/images/creative-square-$TS.png\",\"assets\":$ASSETS,\"sessionLabel\":\"$LABEL\",\"type\":\"$TYPE\"}" \
  | node /workspace/group/scripts/publish/linkedin.mjs

# Reddit
echo "{\"assets\":$ASSETS,\"sessionLabel\":\"$LABEL\",\"type\":\"$TYPE\"}" \
  | node /workspace/group/scripts/publish/reddit.mjs
```

**Para type=news:** passe `headline` e `subline` para x.mjs e reddit.mjs.
**Para type=promo:** `type:"promo"` já aciona o texto correto em x.mjs.

### YouTube — reautorização

Se youtube.mjs sair com código 2 e `needsReauth: true`, escreva IPC para notificar e pule YouTube:

```bash
node -e "
const fs = require('fs');
fs.mkdirSync('/workspace/ipc/messages', { recursive: true });
fs.writeFileSync('/workspace/ipc/messages/yt-reauth-' + Date.now() + '.json', JSON.stringify({
  type: 'message',
  chatJid: '558681512111@s.whatsapp.net',
  text: '⚠️ *Flago — YouTube token expirado*\n\nRode no terminal:\nnode scripts/get-youtube-token.mjs',
  groupFolder: 'whatsapp_alerta-invest',
  timestamp: new Date().toISOString()
}));
"
```

---

## Notificação via WhatsApp

Após publicar em todas as plataformas, monte a mensagem com os URLs reais retornados por cada script e escreva IPC para `558681512111@s.whatsapp.net`:

```bash
node -e "
const fs = require('fs');
const sessionLabel = require('/workspace/group/criativos.json').sessionLabel;

// Substitua pelos URLs reais coletados acima
const xUrl = '<url_x ou FAILED>';
const igUrl = '<url_instagram ou FAILED>';
const ytUrl = '<url_youtube ou FAILED>';
const ttUrl = '<url_tiktok ou FAILED>';
const liUrl = '<url_linkedin ou FAILED>';
const rdUrl = '<url_reddit ou FAILED>';

const lines = [
  '*Flago — ' + sessionLabel + '* ✅',
  '',
  '🐦 X: ' + xUrl,
  '📸 Instagram: ' + igUrl,
  '▶️ YouTube: ' + ytUrl,
  '🎵 TikTok: ' + ttUrl,
  '💼 LinkedIn: ' + liUrl,
  '🤖 Reddit: ' + rdUrl,
].join('\n');

fs.mkdirSync('/workspace/ipc/messages', { recursive: true });
fs.writeFileSync('/workspace/ipc/messages/links-' + Date.now() + '.json', JSON.stringify({
  type: 'message',
  chatJid: '558681512111@s.whatsapp.net',
  text: lines,
  groupFolder: 'whatsapp_alerta-invest',
  timestamp: new Date().toISOString()
}));
console.log('WhatsApp notification written to IPC');
"
```

Plataformas com falha: liste com ❌ e motivo breve. Continue sempre, mesmo com falhas parciais.
