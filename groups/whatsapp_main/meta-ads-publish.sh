#!/bin/bash
# Meta Ads — impulsiona post do Instagram
# Uso: bash meta-ads-publish.sh "<post_id>" "<budget_clicks>" "<budget_engagement>" "<publico>"
# Orçamentos em reais (ex: 25 15). Total não deve ultrapassar R$45/dia.
# Use 0 para não ativar uma das campanhas.

TOKEN="${META_ACCESS_TOKEN:-EAAUJdMVnsVUBRDBFpYuA4lmPPr9pZAJxYnxByY9vY40SSRxTNV0pfhQvZCWZBA9pQAW79ZBd9drC8HV1WZAOLicRcR6eB7iZAldgQIQB27DKicZBMyErUkV9nwDdRkMzKe4ZClhSanK6ZC7SbSuCfp5hcOm46ksavFzC3JmQebTNb0tqyDUsyBDqqHIsNJNV5ZCAZDZD}"
ACCOUNT="${META_AD_ACCOUNT_ID:-act_982549346052514}"
PAGE_ID="${META_PAGE_ID:-100449062944729}"

POST_ID="$1"
BUDGET_CLICKS="${2:-0}"     # em reais
BUDGET_ENG="${3:-0}"        # em reais
PUBLICO="${4:-Público definido pela estratégia}"

if [ -z "$POST_ID" ]; then
  echo "Uso: bash meta-ads-publish.sh \"<post_id>\" \"<budget_clicks>\" \"<budget_eng>\" \"<publico>\""
  echo "Exemplo: bash meta-ads-publish.sh 17950273271965486 25 20 \"Mulheres 25-45, Teresina\""
  exit 1
fi

TOTAL=$((BUDGET_CLICKS + BUDGET_ENG))
if [ "$TOTAL" -gt 45 ]; then
  echo "Erro: orçamento total R\$${TOTAL}/dia excede o limite de R\$45/dia"
  exit 1
fi
if [ "$TOTAL" -eq 0 ]; then
  echo "Erro: pelo menos uma campanha precisa de orçamento > 0"
  exit 1
fi

CAMPAIGN_FILE="/workspace/group/pipeline-campaigns.json"
DATE_TAG=$(date +%Y-%m-%d)

api() { curl -s "$@"; }

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

boost_in_campaign() {
  local campaign_id="$1" label="$2" budget_reais="$3"
  local budget_centavos=$((budget_reais * 100))

  pause_active_adsets "$campaign_id"

  local adset_id
  adset_id=$(api -X POST "https://graph.facebook.com/v21.0/${ACCOUNT}/adsets" \
    -d "name=Pipeline ${DATE_TAG} - ${label}" \
    -d "campaign_id=${campaign_id}" \
    -d "daily_budget=${budget_centavos}" \
    -d "billing_event=IMPRESSIONS" \
    -d "optimization_goal=REACH" \
    -d "targeting={\"geo_locations\":{\"countries\":[\"BR\"]},\"age_min\":22,\"age_max\":55}" \
    -d "status=ACTIVE" \
    -d "access_token=${TOKEN}" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('id','') or d.get('error',{}).get('message',''))" 2>/dev/null)

  [[ "$adset_id" == *"error"* ]] || [ -z "$adset_id" ] && echo "  ERRO conjunto: $adset_id" >&2 && return 1
  echo "  Conjunto: $adset_id (R\$$budget_reais/dia)"

  local creative_id
  creative_id=$(api -X POST "https://graph.facebook.com/v21.0/${ACCOUNT}/adcreatives" \
    -d "name=Pipeline ${DATE_TAG} - ${POST_ID}" \
    -d "object_story_id=${PAGE_ID}_${POST_ID}" \
    -d "access_token=${TOKEN}" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('id','') or d.get('error',{}).get('message',''))" 2>/dev/null)

  [[ "$creative_id" == *"error"* ]] || [ -z "$creative_id" ] && echo "  ERRO creative: $creative_id" >&2 && return 1

  local ad_id
  ad_id=$(api -X POST "https://graph.facebook.com/v21.0/${ACCOUNT}/ads" \
    -d "name=Pipeline ${DATE_TAG} - ${label} - ${POST_ID}" \
    -d "adset_id=${adset_id}" \
    -d "creative={\"creative_id\":\"${creative_id}\"}" \
    -d "status=ACTIVE" \
    -d "access_token=${TOKEN}" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('id','') or d.get('error',{}).get('message',''))" 2>/dev/null)

  [[ "$ad_id" == *"error"* ]] || [ -z "$ad_id" ] && echo "  ERRO anúncio: $ad_id" >&2 && return 1
  echo "  Anúncio ativo: $ad_id"
}

# ─── Main ────────────────────────────────────────────────────────────────────

echo "Post: $POST_ID"
echo "Orçamento: LINK_CLICKS R\$${BUDGET_CLICKS}/dia | ENGAGEMENT R\$${BUDGET_ENG}/dia | Total R\$${TOTAL}/dia"
echo "Público: $PUBLICO"
echo ""

CID_CLICKS=$(get_or_create_campaign "Pipeline - LINK_CLICKS" "LINK_CLICKS")
CID_ENG=$(get_or_create_campaign "Pipeline - OUTCOME_ENGAGEMENT" "OUTCOME_ENGAGEMENT")

if [ "$BUDGET_CLICKS" -gt 0 ]; then
  echo "[LINK_CLICKS] campanha $CID_CLICKS"
  boost_in_campaign "$CID_CLICKS" "CLICKS" "$BUDGET_CLICKS"
else
  echo "[LINK_CLICKS] pulado (R\$0)"
  pause_active_adsets "$CID_CLICKS"
fi

echo ""

if [ "$BUDGET_ENG" -gt 0 ]; then
  echo "[ENGAGEMENT] campanha $CID_ENG"
  boost_in_campaign "$CID_ENG" "ENG" "$BUDGET_ENG"
else
  echo "[ENGAGEMENT] pulado (R\$0)"
  pause_active_adsets "$CID_ENG"
fi

echo ""
echo "Concluído. Total ativo: R\$${TOTAL}/dia"
