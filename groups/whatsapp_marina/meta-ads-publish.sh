#!/bin/bash
# Meta Ads — impulsiona post do Instagram
# Uso: bash meta-ads-publish.sh "<post_id>" "<budget_clicks>" "<budget_engagement>" "<budget_messages>" "<publico>"
# Orçamentos em reais (ex: 12 8 10). Total não deve ultrapassar o limite configurado.
# Use 0 para não ativar uma das campanhas.
# MENSAGENS requer WhatsApp Business API conectado (número +55 86 9827-1911)
#
# Segmentação geográfica (split 60/40):
#   Teresina (60%): key 272278
#   Interior PI - Parnaíba + Picos + Floriano (40%): keys 262714, 263783, 253238
#
# Testes de público disponíveis (passar via variável AUDIENCE_TEST):
#   default   — 22-55 anos, ambos os sexos (padrão)
#   jovens    — 18-35 anos, ambos os sexos
#   mulheres  — 25-50 anos, feminino
#   madura    — 45-65 anos, ambos os sexos (catarata)

TOKEN="${META_ACCESS_TOKEN:-EAAUJdMVnsVUBRDBFpYuA4lmPPr9pZAJxYnxByY9vY40SSRxTNV0pfhQvZCWZBA9pQAW79ZBd9drC8HV1WZAOLicRcR6eB7iZAldgQIQB27DKicZBMyErUkV9nwDdRkMzKe4ZClhSanK6ZC7SbSuCfp5hcOm46ksavFzC3JmQebTNb0tqyDUsyBDqqHIsNJNV5ZCAZDZD}"
ACCOUNT="${META_AD_ACCOUNT_ID:-act_982549346052514}"
PAGE_ID="${META_PAGE_ID:-100449062944729}"
WHATSAPP_NUMBER="+5586982711911"   # Dra Marina Consultório

POST_ID="$1"
BUDGET_CLICKS="${2:-0}"     # em reais
BUDGET_ENG="${3:-0}"        # em reais
BUDGET_MSG="${4:-0}"        # em reais — campanha de Mensagens → WhatsApp
PUBLICO="${5:-Público definido pela estratégia}"
AUDIENCE_TEST="${AUDIENCE_TEST:-default}"  # perfil de público a testar

if [ -z "$POST_ID" ]; then
  echo "Uso: bash meta-ads-publish.sh \"<post_id>\" \"<budget_clicks>\" \"<budget_eng>\" \"<budget_msg>\" \"<publico>\""
  echo "Exemplo: bash meta-ads-publish.sh 17950273271965486 12 8 10 \"Mulheres 25-45, Teresina\""
  exit 1
fi

TOTAL=$((BUDGET_CLICKS + BUDGET_ENG + BUDGET_MSG))
if [ "$TOTAL" -eq 0 ]; then
  echo "Erro: pelo menos uma campanha precisa de orçamento > 0"
  exit 1
fi

CAMPAIGN_FILE="/workspace/group/pipeline-campaigns.json"
DATE_TAG=$(date +%Y-%m-%d)

api() { curl -s "$@"; }

# ─── Perfis de público ────────────────────────────────────────────────────────

get_audience_targeting() {
  local geo="$1"  # teresina | interior

  local cities_teresina='[{"key":"272278"}]'
  local cities_interior='[{"key":"262714"},{"key":"263783"},{"key":"253238"}]'

  local cities
  if [ "$geo" = "teresina" ]; then
    cities="$cities_teresina"
  else
    cities="$cities_interior"
  fi

  case "$AUDIENCE_TEST" in
    jovens)
      echo "{\"geo_locations\":{\"cities\":${cities},\"location_types\":[\"home\",\"recent\"]},\"age_min\":18,\"age_max\":35}"
      ;;
    mulheres)
      echo "{\"geo_locations\":{\"cities\":${cities},\"location_types\":[\"home\",\"recent\"]},\"age_min\":25,\"age_max\":50,\"genders\":[2]}"
      ;;
    madura)
      echo "{\"geo_locations\":{\"cities\":${cities},\"location_types\":[\"home\",\"recent\"]},\"age_min\":45,\"age_max\":65}"
      ;;
    *)
      echo "{\"geo_locations\":{\"cities\":${cities},\"location_types\":[\"home\",\"recent\"]},\"age_min\":22,\"age_max\":55}"
      ;;
  esac
}

# ─── Campanhas ────────────────────────────────────────────────────────────────

get_or_create_campaign() {
  local name="$1" objective="$2"

  if [ -f "$CAMPAIGN_FILE" ]; then
    local cached
    cached=$(python3 -c "
import json, os
d = json.load(open('$CAMPAIGN_FILE')) if os.path.exists('$CAMPAIGN_FILE') else {}
print(d.get('$objective', ''))
" 2>/dev/null)
    [ -n "$cached" ] && echo "$cached" && return
  fi

  local existing
  existing=$(api "https://graph.facebook.com/v21.0/${ACCOUNT}/campaigns?fields=id,name&limit=50&access_token=${TOKEN}" | python3 -c "
import json, sys
for c in json.load(sys.stdin).get('data', []):
    if c['name'] == '$name':
        print(c['id']); sys.exit()
" 2>/dev/null)

  if [ -n "$existing" ]; then
    _save_campaign_id "$objective" "$existing"
    echo "$existing"; return
  fi

  local new_id
  new_id=$(api -X POST "https://graph.facebook.com/v21.0/${ACCOUNT}/campaigns" \
    -d "name=${name}" \
    -d "objective=${objective}" \
    -d "status=ACTIVE" \
    -d "special_ad_categories=[]" \
    -d "access_token=${TOKEN}" | python3 -c "import json,sys; print(json.load(sys.stdin).get('id',''))" 2>/dev/null)

  [ -z "$new_id" ] && echo "ERRO: falha ao criar campanha ${name}" >&2 && exit 1
  _save_campaign_id "$objective" "$new_id"
  echo "$new_id"
}

_save_campaign_id() {
  python3 -c "
import json, os
f = '$CAMPAIGN_FILE'
d = json.load(open(f)) if os.path.exists(f) else {}
d['$1'] = '$2'
json.dump(d, open(f, 'w'), indent=2)
" 2>/dev/null
}

pause_active_adsets() {
  local campaign_id="$1"
  api "https://graph.facebook.com/v21.0/${campaign_id}/adsets?fields=id,status&access_token=${TOKEN}" | python3 -c "
import json, sys
for a in json.load(sys.stdin).get('data', []):
    if a.get('status') == 'ACTIVE':
        print(a['id'])
" 2>/dev/null | while read -r id; do
    api -X POST "https://graph.facebook.com/v21.0/${id}" \
      -d "status=PAUSED" -d "access_token=${TOKEN}" > /dev/null
    echo "  Pausado conjunto anterior: $id"
  done
}

# ─── Boost por geo (Teresina 60% + Interior 40%) ─────────────────────────────

boost_in_campaign() {
  local campaign_id="$1" label="$2" budget_reais="$3" optimization_goal="${4:-REACH}"

  pause_active_adsets "$campaign_id"

  # Split 60/40 — mínimo R$1 por conjunto
  local budget_tsa=$(python3 -c "print(max(1, round($budget_reais * 0.6)))")
  local budget_int=$(python3 -c "print(max(1, round($budget_reais * 0.4)))")

  local creative_id
  creative_id=$(api -X POST "https://graph.facebook.com/v21.0/${ACCOUNT}/adcreatives" \
    -d "name=Pipeline ${DATE_TAG} - ${POST_ID}" \
    -d "object_story_id=${PAGE_ID}_${POST_ID}" \
    -d "access_token=${TOKEN}" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('id','') or d.get('error',{}).get('message',''))" 2>/dev/null)

  [[ "$creative_id" == *"error"* ]] || [ -z "$creative_id" ] && echo "  ERRO creative: $creative_id" >&2 && return 1

  for geo in teresina interior; do
    local geo_label budget_centavos targeting
    if [ "$geo" = "teresina" ]; then
      geo_label="Teresina"
      budget_centavos=$((budget_tsa * 100))
    else
      geo_label="Interior"
      budget_centavos=$((budget_int * 100))
    fi

    targeting=$(get_audience_targeting "$geo")

    local adset_id
    adset_id=$(api -X POST "https://graph.facebook.com/v21.0/${ACCOUNT}/adsets" \
      -d "name=Pipeline ${DATE_TAG} - ${label} - ${geo_label} [${AUDIENCE_TEST}]" \
      -d "campaign_id=${campaign_id}" \
      -d "daily_budget=${budget_centavos}" \
      -d "billing_event=IMPRESSIONS" \
      -d "optimization_goal=${optimization_goal}" \
      -d "targeting=${targeting}" \
      -d "status=ACTIVE" \
      -d "access_token=${TOKEN}" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('id','') or d.get('error',{}).get('message',''))" 2>/dev/null)

    [[ "$adset_id" == *"error"* ]] || [ -z "$adset_id" ] && echo "  ERRO conjunto ${geo_label}: $adset_id" >&2 && continue
    echo "  Conjunto ${geo_label}: $adset_id (R\$$(( budget_centavos / 100 ))/dia | público: ${AUDIENCE_TEST})"

    local ad_id
    ad_id=$(api -X POST "https://graph.facebook.com/v21.0/${ACCOUNT}/ads" \
      -d "name=Pipeline ${DATE_TAG} - ${label} - ${geo_label} - ${POST_ID}" \
      -d "adset_id=${adset_id}" \
      -d "creative={\"creative_id\":\"${creative_id}\"}" \
      -d "status=ACTIVE" \
      -d "access_token=${TOKEN}" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('id','') or d.get('error',{}).get('message',''))" 2>/dev/null)

    [[ "$ad_id" == *"error"* ]] || [ -z "$ad_id" ] && echo "  ERRO anúncio ${geo_label}: $ad_id" >&2 && continue
    echo "  Anúncio ativo ${geo_label}: $ad_id"
  done
}

# ─── Main ────────────────────────────────────────────────────────────────────

echo "Post: $POST_ID"
echo "Público: $PUBLICO (perfil: ${AUDIENCE_TEST})"
echo "Orçamento: LINK_CLICKS R\$${BUDGET_CLICKS}/dia | ENGAGEMENT R\$${BUDGET_ENG}/dia | MENSAGENS R\$${BUDGET_MSG}/dia | Total R\$${TOTAL}/dia"
echo "Geo: Teresina 60% + Interior PI 40% (Parnaíba, Picos, Floriano)"
echo ""

CID_CLICKS=$(get_or_create_campaign "Pipeline - LINK_CLICKS" "LINK_CLICKS")
CID_ENG=$(get_or_create_campaign "Pipeline - OUTCOME_ENGAGEMENT" "OUTCOME_ENGAGEMENT")
CID_MSG=$(get_or_create_campaign "Pipeline - MESSAGES" "OUTCOME_ENGAGEMENT")

if [ "$BUDGET_CLICKS" -gt 0 ]; then
  echo "[LINK_CLICKS] campanha $CID_CLICKS"
  boost_in_campaign "$CID_CLICKS" "CLICKS" "$BUDGET_CLICKS" "LINK_CLICKS"
else
  echo "[LINK_CLICKS] pulado (R\$0)"
  pause_active_adsets "$CID_CLICKS"
fi

echo ""

if [ "$BUDGET_ENG" -gt 0 ]; then
  echo "[ENGAGEMENT] campanha $CID_ENG"
  boost_in_campaign "$CID_ENG" "ENG" "$BUDGET_ENG" "POST_ENGAGEMENT"
else
  echo "[ENGAGEMENT] pulado (R\$0)"
  pause_active_adsets "$CID_ENG"
fi

echo ""

if [ "$BUDGET_MSG" -gt 0 ]; then
  echo "[MENSAGENS → WhatsApp] campanha $CID_MSG"
  echo "  ⚠️  Requer WhatsApp API conectado (${WHATSAPP_NUMBER})"
  boost_in_campaign "$CID_MSG" "MSG" "$BUDGET_MSG" "CONVERSATIONS"
else
  echo "[MENSAGENS] pulado (R\$0)"
  pause_active_adsets "$CID_MSG"
fi

echo ""
echo "Concluído. Total ativo: R\$${TOTAL}/dia"
