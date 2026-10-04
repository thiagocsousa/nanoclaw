# Agenda da Lara — apuração e decisões

Trabalho de engenharia por trás do `iclinic_vagas.py` e da seção F12 do
`groups/whatsapp_atendimento-teste/FAQ.md`. **Não é carregado em runtime** — o FAQ é um
prompt e cada linha compete por atenção do modelo, então a apuração vive aqui.

Base: 240 eventos da agenda do iClinic, 10 semanas (jul–out/2026), e 436 conversas reais
de paciente exportadas do WhatsApp em 03/10/2026.

### Grade da agenda (definida pela clínica em 04/10/2026)

**Janela de atendimento:**

| dia | janela |
|---|---|
| segunda | 08:00 – 12:00 |
| quarta | 14:30 – 18:30 |
| sexta | 08:00 – 12:00 |

**Duração por tipo:**

| tipo | duração |
|---|---|
| Consulta particular | 30 min |
| Consulta Unimed | 20 min |
| Retorno de **cirurgia** (plano ou particular) | 30 min |
| Retorno de consulta normal | 20 min |
| Exame (qualquer) | 10 min |

**Como calcular vaga livre** (para o `iclinic_vagas.py`):
1. Duas pistas independentes — **consulta** e **exame**. Ao procurar vaga de consulta,
   ignore os exames; ao procurar vaga de exame, ignore as consultas (F12 › Comportamento).
2. Dentro da janela do dia, vaga = espaço contíguo livre **≥ a duração do tipo pedido**.
   Não é grade fixa: um pedido de particular (30 min) não cabe num buraco de 20.
3. Ignore itens administrativos ao montar a pista de consulta — no histórico aparecem
   `SOLICITAÇÕES`, `HONORÁRIOS …`, `EXAMES FORA DO CONSULTORIO`. Não são paciente em sala.
4. **Sexta às 13:00 há um compromisso fixo semanal** (7 ocorrências seguidas, sem
   procedimento). Está fora da janela 08:00–12:00, então não atrapalha — mas não trate
   como vaga.

> ✅ **Janelas validadas contra a agenda real** (10 semanas, excluídos itens administrativos):
> segunda 0 agendamentos fora da janela; quarta 1 (um caso isolado às 08:00 em 16/09);
> sexta 10 — e os 10 são exatamente o compromisso fixo das 13:00.
> As janelas declaradas estão corretas.


### Compactação — não deixar buraco na agenda

O tempo da médica é o recurso escasso. **Agenda com buraco é desperdício**: um paciente às
08:00 e o seguinte às 11:00 queima duas horas.

**Regra:** ao escolher qual vaga oferecer, prefira sempre a que fica **encostada** no que já
está marcado — antes ou depois do bloco ocupado.

**Ordem de escolha entre as vagas possíveis:**
1. **Encosta** num agendamento existente (sem buraco entre eles) — melhor opção.
2. Se nenhuma encosta: a **mais próxima** do bloco já ocupado.
3. Empate: **data mais cedo**, depois **horário mais cedo**.

**Dia vazio:** o primeiro paciente do dia **ancora** a agenda — pode marcar onde preferir.
Os seguintes se agrupam em volta dele. Se o primeiro marcou 11:00, ofereça 10:30 ou 11:30
ao próximo, não 08:00.

**Não crie fragmento inútil.** Se encaixar numa posição deixa um buraco menor que 20 min
(a menor consulta que existe), prefira outra posição — aquele pedaço não serve para ninguém.

> ⚠️ Isto redefine "próximo slot disponível" do F12. Para paciente com intenção cirúrgica,
> **"próximo" é a data mais cedo** — mas, dentro dessa data, é a posição **mais compacta**,
> não necessariamente a mais cedo do dia.


### Durações — decisão e validação

As durações declaradas (30 min para particular e retorno de cirurgia) **são as que valem**,
decidido em 04/10/2026, mesmo a agenda histórica vindo marcada de 20 em 20.

> ✅ **Validado: adotar 30 min não reduz a capacidade abaixo da demanda.** Simulei os
> **28 dias de atendimento** das últimas 10 semanas com as durações novas: **nenhum
> estouraria** a janela de 240 min. O dia mais cheio (9 consultas) daria 220 min.
> Média real: 4,8 consultas/dia, contra capacidade de 8 a 9.
>
> | cenário | cabe por dia |
> |---|---|
> | só Unimed (20 min) | 12 |
> | só particular (30 min) | 8 |
> | teto de 5 Unimed + particular | 9 (5×20 + 4×30 = 220 min) |


### Mapa dos procedimentos do iClinic

Levantado dos 240 agendamentos das últimas 10 semanas. É isto que o script usa para
classificar pista, duração, prioridade e cota.

| procedimento (como vem no iClinic) | pista | duração | conta no teto Unimed | perfil |
|---|---|---|---|---|
| `CONSULTA UNIMED` | consulta | 20 min | **SIM** | Unimed rotina |
| `CONSULTA UNIMED CIRURGIA` | consulta | 20 min | **não** (isento) | Unimed cirúrgico — **prioridade 2** |
| `CONSULTA  PARTICULAR` ⚠️ | consulta | 30 min | não | particular rotina |
| `CONSULTA PARTICULAR CIRURGIA` | consulta | 30 min | não | particular cirúrgico — **prioridade 1** |
| `CONSULTA PARTICULAR COM DESCONTO` | consulta | 30 min | não | particular, avaliação a R$ 300 (F05) |
| `RETORNO` | consulta | 20 min | não | retorno de consulta |
| `RETORNO CIRURGIA REFRATIVA` | consulta | 30 min | não | retorno de cirurgia |
| `RETORNO CIRURGIA CATARATA` | consulta | 30 min | não | retorno de cirurgia |
| `TOPOGRAFIA DE CÓRNEA` | **exame** | 10 min | não | — |
| `MAPEAMENTO DE RETINA` | **exame** | 10 min | não | — |
| `CIRURGIA PRK` / `CATARATA` / `LASIK` | — | — | não | cirurgia, não é consultório |
| `HONORÁRIOS CIRURGIA …` | administrativo | — | não | **ignorar** ao montar a pista |
| `SOLICITAÇÕES` | administrativo | — | não | **ignorar** |
| `EXAMES FORA DO CONSULTORIO` | administrativo | — | não | **ignorar** |
| *(sem procedimento)* | — | — | não | ver nota abaixo |

> ⚠️ **`CONSULTA  PARTICULAR` tem DOIS espaços** entre as palavras, e
> `CONSULTA PARTICULAR CIRURGIA` tem um. Normalize espaço em branco antes de comparar,
> senão a classificação falha em 24 agendamentos.

> **Teto de 5/dia conta só `CONSULTA UNIMED`.** O `CONSULTA UNIMED CIRURGIA` é isento,
> como manda a regra de intenção cirúrgica (F12 › Regras por perfil).

> **Sem procedimento (23 casos):** 20 deles são o recorrente *"Atendimento Lígia"* às 13:00,
> toda terça e sexta — fora das janelas de atendimento, então não afeta o cálculo de vaga.
> Os outros 3 são isolados (00:00 e 08:00). Trate agendamento sem procedimento como
> **bloqueio** (ocupa, mas não é consulta para fins de cota).

> ⚠️ **`CONSULTA IPMT` existe na agenda e não deveria.** Três ocorrências, todas
> comparecidas: 20/08 (16:00 e 17:00, quinta) e 23/09 (16:00, quarta). A regra de 04/10
> diz que IPMT **não** faz consulta, só cirurgia pelo PLANTE. Duas das três caem numa
> quinta, que não é dia de consultório — possivelmente foram atendidas em outro local.
> **Confirmar:** a regra é nova (e esses são casos antigos) ou existe exceção? Enquanto
> não souber, se um paciente IPMT pedir consulta, a Lara segue a regra: **não atende**.


### Lacuna — o que ainda falta

1. ~~`iclinic_vagas.py`~~ — **escrito em 04/10/2026.** Lógica testada (casos sintéticos +
   replay de dias reais da agenda). ⚠️ O **login não foi testado de ponta a ponta** —
   `ICLINIC_EMAIL`/`ICLINIC_PASSWORD` não existem na máquina local; já estão em
   `FORWARDED_ENV_VARS`, então devem funcionar no container. **Rodar uma vez no container
   antes de confiar.**
2. **Escrever na agenda** — fora do escopo. Informar vaga e efetivar agendamento são
   capacidades diferentes; por ora a segunda é humana, o que preserva a trava de nunca
   mexer em consulta de terceiro.
3. **`CONSULTA IPMT`** — ver Mapa dos procedimentos: existe na agenda e, pela regra de
   04/10, não deveria.


## Pendências

### Agora (ambiente de teste)
1. **Rodada 2 do teste** com a persona corrigida: medir tom e taxa de invenção.
2. **Guardrail de saída** — ainda não existe. Hoje a trava é só a instrução no prompt.
3. ~~`iclinic_vagas.py`~~ — escrito. Falta **rodar uma vez no container** para validar
   o login (ver F12 › Lacuna).
4. ~~Confirmar se exame ocupa slot de consulta~~ — resolvido em 04/10: pistas separadas.

### Trava de go-live (produção)
3. **Trocar o template "Sou a Bruna" para "Lara"** antes do primeiro paciente real.
   Adiado deliberadamente até o fim dos testes (decisão de 04/10/2026).
4. **Copiar `FAQ.md` para `groups/whatsapp_atendimento-dra-marina/`** e conferir que o
   `.gitignore` rastreia o arquivo lá também.
5. **Revalidar os valores** — todos são de 04/10/2026 e mudam sem aviso.

### Resolvido com a clínica em 04/10/2026
- Convênios: tabela fechada (particular e Unimed p/ consulta; IASPI→PLAMTA, IPMT→PLANTE
  só p/ cirurgia; nenhum outro plano, pode dizer que não atende).
- Endereço: Elias João Tajra (atendimento). Pires de Castro é a matriz, só nota fiscal.
- Dias de atendimento: apurados na agenda do iClinic (seg manhã, qua tarde, sex manhã).
- Valores: consulta R$ 430 (R$ 300 com intenção de cirurgia); mapeamento R$ 300 (R$ 200) e
  topografia R$ 380 (R$ 220) para cirúrgico particular. Pentacam retirado da lista.
- Valor de cirurgia: **nunca** antes da consulta — regra dura.


## Pendências de arquitetura (levantadas na revisão de 04/10/2026)

- **Onde a Lara roda em produção.** `src/ipc.ts` define `DM_GATED_FOLDERS` com
  `whatsapp_atendimento-dra-marina`: DM livre de agente para paciente é bloqueada ali, e o
  `CLAUDE.md` daquele grupo abre com "NUNCA fala com paciente". Copiar o FAQ para lá não
  liga a Lara — go-live exige decidir a pasta dela e mexer no gate.
- **`CONSULTA IPMT` na agenda** contraria a regra de 04/10 (IPMT não faz consulta).
- **Login do iClinic** é o mesmo bloco Playwright em 8 scripts. Duplicação forçada pelo
  isolamento das pastas de grupo; revisitar se o iClinic mudar o formulário.
