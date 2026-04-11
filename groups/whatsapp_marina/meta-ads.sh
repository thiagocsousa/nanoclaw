#!/bin/bash
# Meta Ads — busca métricas de campanhas
# Uso: bash meta-ads.sh [campanhas|conjuntos|anuncios] [dias|historico]
# Exemplos:
#   bash meta-ads.sh campanhas 7          → últimos 7 dias
#   bash meta-ads.sh campanhas historico  → todo o histórico
#   bash meta-ads.sh conjuntos 30
#   bash meta-ads.sh anuncios historico

TOKEN="${META_ACCESS_TOKEN:-EAAUJdMVnsVUBRDBFpYuA4lmPPr9pZAJxYnxByY9vY40SSRxTNV0pfhQvZCWZBA9pQAW79ZBd9drC8HV1WZAOLicRcR6eB7iZAldgQIQB27DKicZBMyErUkV9nwDdRkMzKe4ZClhSanK6ZC7SbSuCfp5hcOm46ksavFzC3JmQebTNb0tqyDUsyBDqqHIsNJNV5ZCAZDZD}"
ACCOUNT="${META_AD_ACCOUNT_ID:-act_982549346052514}"
TIPO="${1:-campanhas}"
PERIODO="${2:-7}"

if [ -z "$TOKEN" ] || [ -z "$ACCOUNT" ]; then
  echo "Erro: META_ACCESS_TOKEN e META_AD_ACCOUNT_ID precisam estar definidos."
  exit 1
fi

if [ "$PERIODO" = "historico" ]; then
  DATE_PRESET="maximum"
  PERIODO_LABEL="histórico completo"
else
  DATE_PRESET="last_${PERIODO}_d"
  PERIODO_LABEL="últimos ${PERIODO} dias"
fi

FIELDS="name,status,insights.date_preset(${DATE_PRESET}){impressions,clicks,ctr,cpc,spend,actions,cost_per_action_type}"

case "$TIPO" in
  campanhas)
    ENDPOINT="https://graph.facebook.com/v21.0/${ACCOUNT}/campaigns"
    LIMIT=50
    ;;
  conjuntos)
    ENDPOINT="https://graph.facebook.com/v21.0/${ACCOUNT}/adsets"
    LIMIT=50
    ;;
  anuncios)
    ENDPOINT="https://graph.facebook.com/v21.0/${ACCOUNT}/ads"
    LIMIT=100
    ;;
  *)
    echo "Tipo inválido. Use: campanhas, conjuntos ou anuncios"
    exit 1
    ;;
esac

echo "=== $TIPO — $PERIODO_LABEL ==="
echo ""

curl -s "${ENDPOINT}?fields=${FIELDS}&limit=${LIMIT}&access_token=${TOKEN}" | python3 -c "
import json, sys
data = json.load(sys.stdin)
items = data.get('data', [])
if not items:
    print('Nenhum dado encontrado.')
    sys.exit(0)

total_spend = 0
total_leads = 0
sem_dados = 0

for item in items:
    insights = item.get('insights', {}).get('data', [])
    if not insights:
        sem_dados += 1
        continue

    i = insights[0]
    impressions = int(i.get('impressions', 0))
    clicks      = int(i.get('clicks', 0))
    ctr         = float(i.get('ctr', 0))
    cpc         = float(i.get('cpc', 0))
    spend       = float(i.get('spend', 0))
    actions     = i.get('actions', [])
    leads = next((int(a['value']) for a in actions if a['action_type'] in ('lead','onsite_conversion.lead_grouped')), 0)
    results = next((int(a['value']) for a in actions if a['action_type'] == 'offsite_conversion.fb_pixel_lead'), leads)
    cpl = round(spend / results, 2) if results > 0 else None

    total_spend += spend
    total_leads += results

    print(f\"\\n{'='*50}\")
    print(f\"Nome:   {item.get('name', 'N/A')}\")
    print(f\"Status: {item.get('status', 'N/A')}\")
    print(f\"Gasto:  R\$ {spend:.2f}\")
    print(f\"Impres: {impressions:,}\")
    print(f\"Clicks: {clicks:,}\")
    print(f\"CTR:    {ctr:.2f}%\")
    print(f\"CPC:    R\$ {cpc:.2f}\")
    print(f\"Leads:  {results}\")
    if cpl:
        print(f\"CPL:    R\$ {cpl:.2f}\")

print(f\"\\n{'='*50}\")
print(f\"TOTAIS\")
print(f\"Gasto total:  R\$ {total_spend:.2f}\")
print(f\"Leads totais: {total_leads}\")
cpl_medio = round(total_spend / total_leads, 2) if total_leads > 0 else None
if cpl_medio:
    print(f\"CPL médio:    R\$ {cpl_medio:.2f}\")
if sem_dados:
    print(f\"Sem dados: {sem_dados} item(ns) sem atividade no período\")
"
