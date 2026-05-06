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
| 01:30–04:59 | Seg–Sex | Early Asia | `nikkei225`, `kospi`, `asx200` |
| 05:00–08:59 | Seg–Sex | Late Asia | `hsi`, `jkse`, `klse`, `set50`, `nsei` |
| 09:00–14:29 | Seg–Sex | Europe | `ftse100`, `dax`, `cac40`, `aex`, `smi`, `omx`, `ibex35`, `jse` |
| 14:30–23:59 | Seg–Sex | Americas | `sp500`, `tsx`, `ipc`, `ibov` |
| qualquer | Sáb–Dom | Global | todos |

Filtre os sinais pela zona. Nunca use sinais de outra zona.

**Se a zona filtrar menos de 2 sinais → use `type: "promo"` e `assets: []`.** Não invente dados.

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

Leia `criativos.json`. Derive `$TS` do arquivo mais recente e capture o output JSON de cada script:

```bash
TS=$(ls -t /workspace/group/tmp/images/creative-square-*.png 2>/dev/null | head -1 | grep -oE '[0-9]{10}')
ASSETS=$(node -e "const c=require('/workspace/group/criativos.json'); console.log(JSON.stringify(c.assets))")
LABEL=$(node -e "const c=require('/workspace/group/criativos.json'); console.log(c.sessionLabel)")
TYPE=$(node -e "const c=require('/workspace/group/criativos.json'); console.log(c.type)")

# X / Twitter — text-only (capture output for log)
X_OUT=$(echo "{\"assets\":$ASSETS,\"sessionLabel\":\"$LABEL\",\"type\":\"$TYPE\",\"landscapePath\":\"/workspace/group/tmp/images/creative-landscape-$TS.png\"}" \
  | node /workspace/group/scripts/publish/x.mjs 2>&1) || true
echo "X: $X_OUT"

# Instagram + Facebook — upload to Cloudinary first to get public URL
UPLOAD_OUT=$(echo "{\"imagePath\":\"/workspace/group/tmp/images/creative-square-$TS.png\"}" \
  | node /workspace/group/scripts/upload-image.mjs 2>&1) || true
IMAGE_URL=$(node -e "try{const d=JSON.parse(process.argv[1]);console.log(d.url||'')}catch{console.log('')}" "$UPLOAD_OUT")
if [ -n "$IMAGE_URL" ]; then
  META_OUT=$(echo "{\"imageUrl\":\"$IMAGE_URL\",\"assets\":$ASSETS,\"sessionLabel\":\"$LABEL\",\"type\":\"$TYPE\"}" \
    | node /workspace/group/scripts/publish/meta.mjs 2>&1) || true
else
  META_OUT="{\"success\":false,\"error\":\"Cloudinary upload failed: $UPLOAD_OUT\"}"
fi
echo "Meta: $META_OUT"

# Boost Instagram post — only for Americas Open (10:30 NY / 16:30 Lisbon), $5/day × 1 day
IG_POST_ID=$(node -e "try{const d=JSON.parse(process.argv[1]);const r=d.results||d;console.log(r.instagram?.postId||'')}catch{console.log('')}" "$META_OUT")
if [ -n "$IG_POST_ID" ] && echo "$LABEL" | grep -qi "americas open"; then
  BOOST_OUT=$(echo "{\"igMediaId\":\"$IG_POST_ID\",\"geos\":[\"US\",\"CA\",\"MX\",\"BR\",\"GB\",\"DE\",\"FR\"],\"dailyBudgetUsd\":5,\"durationDays\":1}" \
    | node /workspace/group/scripts/ads/meta.mjs 2>&1) || true
  echo "MetaAds: $BOOST_OUT"
fi

# TikTok
TT_OUT=$(echo "{\"videoPath\":\"/workspace/group/tmp/images/creative-video-$TS.mp4\",\"assets\":$ASSETS,\"sessionLabel\":\"$LABEL\",\"type\":\"$TYPE\"}" \
  | node /workspace/group/scripts/publish/tiktok.mjs 2>&1) || true
echo "TikTok: $TT_OUT"

# YouTube Shorts
YT_OUT=$(echo "{\"videoPath\":\"/workspace/group/tmp/images/creative-video-$TS.mp4\",\"assets\":$ASSETS,\"sessionLabel\":\"$LABEL\",\"type\":\"$TYPE\"}" \
  | node /workspace/group/scripts/publish/youtube.mjs 2>&1) || true
echo "YouTube: $YT_OUT"

# LinkedIn
LI_OUT=$(echo "{\"squarePath\":\"/workspace/group/tmp/images/creative-square-$TS.png\",\"assets\":$ASSETS,\"sessionLabel\":\"$LABEL\",\"type\":\"$TYPE\"}" \
  | node /workspace/group/scripts/publish/linkedin.mjs 2>&1) || true
echo "LinkedIn: $LI_OUT"

# Reddit
RD_OUT=$(echo "{\"assets\":$ASSETS,\"sessionLabel\":\"$LABEL\",\"type\":\"$TYPE\"}" \
  | node /workspace/group/scripts/publish/reddit.mjs 2>&1) || true
echo "Reddit: $RD_OUT"
```

Parse cada `*_OUT` como JSON. Se `success: true` → usa `url`. Se `error` presente → registra a mensagem de erro.

**Para type=news:** passe `headline` e `subline` para x.mjs e reddit.mjs.
**Para type=promo:** `type:"promo"` já aciona o texto correto em x.mjs.

### YouTube — reautorização

Se `YT_OUT` tiver `needsReauth: true`, escreva IPC de notificação e trate YouTube como falha:

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

### Salvar Run Log

Após coletar todos os outputs, salve `/workspace/group/tmp/pipeline-last-run.json` com os resultados reais:

```bash
node -e "
const fs = require('fs');

// Parse outputs capturados — extraia success, url, error de cada JSON
function parse(raw) {
  try {
    const j = JSON.parse(raw.trim().split('\n').filter(l => l.startsWith('{')).pop() || raw);
    return { success: j.success === true, url: j.url || null, error: j.error || null };
  } catch { return { success: false, url: null, error: raw.slice(0, 200) }; }
}

const results = {
  run_at: new Date().toISOString(),
  sessionLabel: require('/workspace/group/criativos.json').sessionLabel,
  type: require('/workspace/group/criativos.json').type,
  platforms: {
    x:        parse(process.env.X_OUT   || ''),
    instagram: parse(process.env.META_OUT || ''),
    tiktok:   parse(process.env.TT_OUT  || ''),
    youtube:  parse(process.env.YT_OUT  || ''),
    linkedin: parse(process.env.LI_OUT  || ''),
    reddit:   parse(process.env.RD_OUT  || ''),
  }
};
fs.mkdirSync('/workspace/group/tmp', { recursive: true });
fs.writeFileSync('/workspace/group/tmp/pipeline-last-run.json', JSON.stringify(results, null, 2));
console.log('Run log saved');
" X_OUT="$X_OUT" META_OUT="$META_OUT" TT_OUT="$TT_OUT" YT_OUT="$YT_OUT" LI_OUT="$LI_OUT" RD_OUT="$RD_OUT"
```

---

## Notificação via WhatsApp

Após salvar o run log, escreva o arquivo IPC de notificação diretamente via bash:

```bash
node -e "
const fs = require('fs');
function parse(raw, key) {
  try {
    const j = JSON.parse((raw||'').trim().split('\n').filter(l => l.startsWith('{')).pop() || raw);
    const r = key ? (j.results?.[key] || j) : j;
    return { success: r.success === true, url: r.url || null, error: r.error || null };
  } catch { return { success: false, url: null, error: null }; }
}
const p = {
  x:         parse(process.env.X_OUT),
  instagram: parse(process.env.META_OUT, 'instagram'),
  youtube:   parse(process.env.YT_OUT),
  tiktok:    parse(process.env.TT_OUT),
  linkedin:  parse(process.env.LI_OUT),
  reddit:    parse(process.env.RD_OUT),
};
const label = process.env.LABEL || 'Pipeline';
const line = (e, n, r) => r.success ? \`\${e} \${n}: \${r.url||'ok'}\` : \`\${e} \${n}: ❌ \${(r.error||'').slice(0,60)}\`;
const text = [
  \`*Flago — \${label}* ✅\`, '',
  line('🐦','X',p.x),
  line('📸','Instagram',p.instagram),
  line('▶️','YouTube',p.youtube),
  line('🎵','TikTok',p.tiktok),
  line('💼','LinkedIn',p.linkedin),
  line('🤖','Reddit',p.reddit),
].join('\n');
fs.mkdirSync('/workspace/ipc/messages', { recursive: true });
fs.writeFileSync('/workspace/ipc/messages/notify-' + Date.now() + '.json', JSON.stringify({
  type: 'message',
  chatJid: '558681512111@s.whatsapp.net',
  groupFolder: 'whatsapp_alerta-invest',
  text,
  timestamp: new Date().toISOString(),
}));
console.log('Notification queued');
" X_OUT="$X_OUT" META_OUT="$META_OUT" YT_OUT="$YT_OUT" TT_OUT="$TT_OUT" LI_OUT="$LI_OUT" RD_OUT="$RD_OUT" LABEL="$LABEL"
```
