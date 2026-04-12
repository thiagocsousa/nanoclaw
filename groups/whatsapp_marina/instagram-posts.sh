#!/bin/bash
# Instagram — busca posts recentes da conta vinculada à página
# Uso: bash instagram-posts.sh [quantidade]
# Exemplo: bash instagram-posts.sh 20

TOKEN="${META_ACCESS_TOKEN}"
IG_ID="${META_INSTAGRAM_ID}"
LIMIT="${1:-20}"

if [ -z "$TOKEN" ] || [ -z "$IG_ID" ]; then
  echo "Erro: META_ACCESS_TOKEN e META_INSTAGRAM_ID precisam estar definidos"
  exit 1
fi

# Buscar posts recentes (sem insights inline — requer chamada separada para system users)
curl -s \
  "https://graph.facebook.com/v21.0/${IG_ID}/media?fields=id,caption,media_type,timestamp,like_count,comments_count&limit=${LIMIT}&access_token=${TOKEN}" | python3 -c "
import json, sys
data = json.load(sys.stdin)
posts = data.get('data', [])

if not posts:
    err = data.get('error', {})
    if err:
        print(f'Erro API: {err.get(\"message\")}')
    else:
        print('Nenhum post encontrado.')
    sys.exit(0)

for i, post in enumerate(posts, 1):
    print(f'\n--- Post {i} ---')
    print(f'ID:          {post.get(\"id\")}')
    ts = post.get('timestamp', '')[:10]
    print(f'Data:        {ts}')
    print(f'Tipo:        {post.get(\"media_type\", \"\")}')
    caption = post.get('caption', '')[:300].replace('\n', ' ')
    print(f'Legenda:     {caption}')
    print(f'Curtidas:    {post.get(\"like_count\", 0)}')
    print(f'Comentários: {post.get(\"comments_count\", 0)}')
"
