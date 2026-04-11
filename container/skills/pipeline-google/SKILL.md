---
name: pipeline-google
description: Pipeline de análise Google Ads para cirurgia refrativa e catarata — diagnóstico completo de campanhas, grupos, palavras-chave, termos de pesquisa e audiências, com recomendações de otimização.
---

# /pipeline-google — Análise Google Ads

Execute quando o usuário pedir análise do Google Ads, revisão de campanhas, ou otimização de refrativa/catarata.

## Passo 1 — Coleta de dados

Rode todos em paralelo:

```bash
node /workspace/group/google-ads.mjs campanhas 30 > /tmp/gads-campanhas.txt 2>&1 &
node /workspace/group/google-ads.mjs campanhas historico >> /tmp/gads-campanhas.txt 2>&1 &
node /workspace/group/google-ads.mjs keywords 30 refrativa > /tmp/gads-kw-refrativa.txt 2>&1 &
node /workspace/group/google-ads.mjs keywords 30 catarata > /tmp/gads-kw-catarata.txt 2>&1 &
node /workspace/group/google-ads.mjs termos 30 > /tmp/gads-termos.txt 2>&1 &
node /workspace/group/google-ads.mjs audiencias 30 > /tmp/gads-audiencias.txt 2>&1 &
wait

cat /tmp/gads-campanhas.txt
cat /tmp/gads-kw-refrativa.txt
cat /tmp/gads-kw-catarata.txt
cat /tmp/gads-termos.txt
cat /tmp/gads-audiencias.txt
```

## Passo 2 — Subagente Analista

Spawne um subagente com este prompt (substitua `{dados}` pelos dados coletados):

```
Você é analista de Google Ads especializado em saúde ocular — cirurgia refrativa (LASIK, PRK, SMILE, ICL) e catarata.

Analise os dados abaixo em duas camadas:

## Visão histórica
- Quais campanhas geraram mais conversões com menor CPL
- Palavras-chave com melhor desempenho (CTR, taxa de conversão)
- Palavras-chave desperdiçando verba (alto gasto, zero conversão)
- Termos de pesquisa relevantes ainda não capturados como keywords
- Termos irrelevantes que precisam virar palavras negativas

## Visão recente (30 dias)
- O que está funcionando agora
- O que está drenando orçamento sem retorno
- Oportunidades de bid ajustado por audiência (faixa etária, dispositivo)
- Quality Score e impression share das principais keywords

## Conclusão para o gestor
- Top 5 ações de otimização prioritárias (com impacto estimado)
- Palavras a pausar imediatamente
- Palavras negativas a adicionar
- Ajustes de lance por segmento
- Benchmarks: CPL ideal para refrativa vs catarata

Dados:
{dados}
```

Salve como `analise_google`.

## Passo 3 — Subagente Gestor

Spawne um subagente com este prompt:

```
Você é gestor de Google Ads para clínica de cirurgia ocular.

Com base na análise abaixo, defina a estratégia da próxima semana:

1. *Diagnóstico* — situação atual em 3 linhas
2. *Problemas críticos* — o que corrigir hoje
3. *Ações recomendadas*
   - Alta prioridade (impacto imediato)
   - Média prioridade (próximas 2 semanas)
   - Baixa prioridade (próximo mês)
4. *Distribuição de orçamento sugerida*
   - Refrativa: R$ X/dia (campanhas X e Y)
   - Catarata: R$ X/dia (campanha Z)
   - Justificativa
5. *Palavras negativas a adicionar* (lista)
6. *Palavras novas a testar* (lista com tipo de correspondência)

Análise:
{analise_google}
```

Salve como `estrategia_google`.

## Formato da resposta final

Após os subagentes, consolide e envie:

```
*Google Ads — Análise Semanal*

*Diagnóstico:*
{resumo do analista}

*Estratégia:*
{ações priorizadas do gestor}

*Distribuição sugerida:*
• Refrativa: R$ X/dia
• Catarata: R$ X/dia

*Palavras negativas a adicionar:*
{lista}
```

Use formatação WhatsApp (*bold*, _italic_, • bullets). Sem ## headings.

Numere cada ação recomendada (1, 2, 3...) e ao final pergunte:
> *Quer que eu aplique as otimizações? Responda SIM para aplicar todas, ou liste os números (ex: 1, 3, 5).*

## Passo 4 — Aplicar otimizações (após aprovação)

Quando o usuário responder com SIM ou números, monte o JSON de ações e execute:

```bash
node /workspace/group/google-ads-apply.mjs << 'EOF'
{
  "actions": [
    { "type": "add_negative", "scope": "campaign", "campaignName": "...", "keyword": "...", "matchType": "BROAD" },
    { "type": "pause_keyword", "campaignName": "...", "adGroupName": "...", "keywordText": "..." },
    { "type": "adjust_bid", "campaignName": "...", "adGroupName": "...", "keywordText": "...", "bidReais": 3.50 },
    { "type": "add_keyword", "campaignName": "...", "adGroupName": "...", "keywordText": "...", "matchType": "PHRASE", "bidReais": 2.00 },
    { "type": "adjust_budget", "campaignName": "...", "dailyBudgetReais": 40 }
  ]
}
EOF
```

Tipos de ação disponíveis:
- `add_negative` — adiciona palavra negativa (`scope`: `campaign` ou `ad_group`)
- `pause_keyword` — pausa keyword que está desperdiçando verba
- `enable_keyword` — reativa keyword pausada
- `adjust_bid` — ajusta lance de keyword específica
- `add_keyword` — adiciona nova keyword ao grupo (`matchType`: BROAD, PHRASE, EXACT)
- `pause_ad_group` — pausa grupo inteiro
- `adjust_budget` — altera orçamento diário da campanha

Após executar, confirme cada ação aplicada e informe erros se houver.
