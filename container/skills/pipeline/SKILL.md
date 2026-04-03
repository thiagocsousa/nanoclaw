---
name: pipeline
description: Pipeline de análise de tráfego pago — encadeia três subagentes (analista → gestor → seletor de posts) para análise completa e seleção de posts do Instagram para impulsionamento.
---

# /pipeline — Análise Completa de Campanha

Execute quando o usuário pedir análise completa de campanha, pipeline, ou quando enviar dados brutos de campanha (CTR, CPC, CPL, leads, agendamentos).

## Como executar

Use o Agent tool para encadear três subagentes em sequência. Cada subagente recebe o output do anterior como contexto.

### Passo 1 — Analista

Antes de spawnar o subagente, busque o histórico completo e os dados recentes:

```bash
echo "=== HISTÓRICO COMPLETO ===" && \
bash /workspace/group/meta-ads.sh campanhas historico && \
bash /workspace/group/meta-ads.sh conjuntos historico && \
bash /workspace/group/meta-ads.sh anuncios historico && \
echo "" && \
echo "=== ÚLTIMOS 7 DIAS ===" && \
bash /workspace/group/meta-ads.sh campanhas 7
```

Spawne um subagente com este prompt (substitua `{dados}` pelos dados coletados acima):

```
Analise campanhas de tráfego pago.

Considere:
- CTR
- CPC
- CPL
- Conversão

Responda:
1. O que está funcionando
2. O que não está
3. O que testar
4. O que pausar

Seja direto.

Contexto:
{dados}
```

Salve o resultado como `analise`.

### Passo 2 — Gestor

Spawne um subagente com este prompt (substitua `{analise}` pelo resultado do passo 1):

```
Você é um gestor de tráfego pago especializado em cirurgia refrativa.

Seu objetivo é gerar pacientes qualificados (não apenas leads).

Você deve:
- Analisar campanhas
- Identificar problemas
- Sugerir melhorias
- Priorizar ações com maior impacto em agendamentos

Considere:
- Qualidade do lead > quantidade
- Segurança e credibilidade são essenciais
- Evitar promessas exageradas

Formato da resposta:
1. Diagnóstico
2. Problemas
3. Ações recomendadas (prioridade alta, média, baixa)
4. Distribuição de orçamento sugerida para o boost desta semana (total R$45/dia):
   - LINK_CLICKS: R$XX/dia
   - ENGAGEMENT: R$XX/dia
   - Justificativa da divisão

Contexto:
{analise}
```

Salve o resultado como `estrategia`.

### Passo 3 — Seletor de Posts

Antes de spawnar, busque os posts recentes do Instagram:

```bash
bash /workspace/group/instagram-posts.sh 20
```

Spawne um subagente com este prompt (substitua `{posts}` e `{estrategia}`):

```
Você é especialista em conteúdo orgânico para Instagram na área de saúde, com foco em cirurgia refrativa.

Sua tarefa é analisar os posts recentes do Instagram da clínica e identificar quais têm maior potencial de engajamento para ser impulsionados como anúncio, alinhado à estratégia definida pelo gestor.

Para cada post avaliado, considere:
- Relevância para o público-alvo (pessoas com interesse real em corrigir a visão)
- Alinhamento com a estratégia atual
- Potencial de engajamento orgânico já demonstrado (curtidas, comentários, salvamentos)
- Credibilidade médica e conformidade com diretrizes do CFM e Meta Ads

Responda:
1. Top 3 posts para impulsionar (com ID e justificativa alinhada à estratégia)
2. Por que cada um se encaixa na estratégia
3. Sugestão de público-alvo para cada impulsionamento
4. O que NÃO impulsionar (e por quê)

Seja direto. Priorize qualidade de lead sobre alcance.

Estratégia do gestor:
{estrategia}

Posts do Instagram:
{posts}
```

Salve o resultado como `selecao`.

## Formato da resposta final

Após os 3 subagentes concluírem, consolide e envie ao usuário:

```
*Análise Semanal de Campanhas*

*Análise:*
{resumo do analista}

*Estratégia:*
{diagnóstico + ações priorizadas do gestor}

*Posts para Impulsionar:*
{top 3 posts com justificativa e público sugerido}

*Não impulsionar:*
{posts a evitar e motivo}
```

Use formatação WhatsApp (*bold*, _italic_, • bullets). Sem ## headings, sem **double stars**.

Inclua na resposta a distribuição de orçamento sugerida pelo gestor:
> *Distribuição sugerida: LINK_CLICKS R$XX | ENGAGEMENT R$XX*

Após enviar, pergunte:
> *Quais posts você quer impulsionar?* Responda com os números (ex: 1, 3) ou *nenhum* para cancelar.

Quando o usuário aprovar, use a distribuição sugerida pelo gestor para chamar o script:
```bash
bash /workspace/group/meta-ads-publish.sh "<post_id>" "<budget_clicks>" "<budget_eng>" "<publico>"
```
Exemplo: `bash /workspace/group/meta-ads-publish.sh 17950273271965486 25 20 "Mulheres 25-45, Teresina"`
