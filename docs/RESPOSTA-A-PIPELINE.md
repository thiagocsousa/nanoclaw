# Resposta a pipeline não é conversa com a Lara

Plano escrito em 22/10/2026, do primeiro dia útil da semana de observação.
**Implementado** em 22/10/2026 (`src/resposta-pipeline.ts`).

## O problema

A clínica dispara mensagens automáticas ao paciente. O paciente responde — e a
resposta vira turno da Lara, que não sabe que aquilo pertence a um pipeline.

Medido hoje, às 18:00 UTC (15h local), quando o lembrete saiu:

```
18:01:51  Sim!          18:02:00  SIM          18:03:17  SIM
19:04:56  SIM           19:12:38  Confirmado   19:40:26  Sim
```

Cada um produziu uma resposta da Lara. Na fila de revisão, agora:

| intenção | quantas |
|---|---|
| `DESCONHECIDO` → "Só um instante." | **24** de 55 (44%) |
| `abertura` | 10 |
| `agradece_fecha` | 8 (inclusive um "Confirmado" → *"Eu que agradeço!"*) |

✅ **Nada chegou ao paciente**: zero "Só um instante." enviado hoje. A trava de
egresso segurou. Hoje o custo é RUÍDO — e ruído é o que faz a Marina ler lixo em
vez de atendimento. Quando a Lara assumir, deixa de ser ruído.

## Os pipelines

| pipeline | script | pasta de origem | `origin` declarada |
|---|---|---|---|
| lembrete de consulta (15h) | `send_reminder.py` | `atendimento-dra-marina` | `send_reminder` |
| auto-resposta ao lembrete | `lembrete_autoreply.py` | `atendimento-dra-marina` | `lembrete_autoreply` |
| nota fiscal (DANFSE) | `send_nota.py` | `atendimento-dra-marina` | `send_nota` |
| avaliação no Google | `send_avaliacao.py` | **`marina`** | **nenhuma** |
| lembrete de 1 ano | `send_retorno.py` | **`marina`** | **nenhuma** |

⚠️ **Dois dos cinco não declaram origem.** E eles escrevem IPC com
`groupFolder: "whatsapp_atendimento-dra-marina"` — a pasta GATEADA — saindo de
`whatsapp_marina`. Só não são bloqueados porque `patientDmBlocked` olha a pasta
de **onde o arquivo saiu** (`sourceGroup`), não a do destino. Funciona hoje; é
frágil por acidente, não por desenho.

## Por que o host não consegue distinguir

1. **`messages` não tem coluna de origem.** A informação existe no IPC
   (`data.origin`) e **se perde na gravação**.
2. **Até hoje de manhã a mensagem do pipeline nem ficava no chat**: o canal
   descartava `fromMe`. Com o conserto de hoje ela passa a ser gravada — o que,
   por acaso, é o que torna esta correção possível.

## O desenho

> A conversa pertence ao pipeline enquanto a resposta for **sobre o que ele
> perguntou**. Deixa de pertencer no instante em que o paciente traz assunto
> novo.

### 1. A origem sobrevive à gravação

Coluna `origin` em `messages` (ou um campo no mesmo lugar onde `is_bot_message`
já mora). Preenchida no egresso do IPC, que já tem `data.origin` na mão.

### 2. As duas pipelines sem origem passam a declarar

`send_avaliacao.py` → `origin: "send_avaliacao"`.
`send_retorno.py` → `origin: "send_retorno"`.
E as duas entram em `DM_ALLOWED_ORIGINS`, para pararem de depender de qual pasta
as hospeda. ⚠️ Isto muda o gate: hoje elas passam por não serem gateadas; depois
passarão por serem **autorizadas**, que é diferente.

### 3. O recorte da supressão

⛔ **Suprimir tudo por N horas seria pior que o defeito.** Quem responde "SIM" ao
lembrete e dez minutos depois escreve "posso remarcar?" precisa ser atendido —
e "posso remarcar?" é exatamente o caso que a recepção quer ver.

A supressão vale quando **as três** valem:

- a última mensagem de saída daquele chat tem `origin` de pipeline;
- ela é recente (janela por pipeline: o lembrete pede confirmação até o dia
  seguinte; a nota fiscal não pede nada);
- a resposta do paciente é **curta e confirmatória** — "sim", "ok",
  "confirmado", "obrigado", "recebi". Qualquer pergunta, negativa com pedido, ou
  mensagem longa **não** é suprimida.

Suprimir = não abrir turno. A mensagem continua **gravada como contexto**, igual
ao que foi feito hoje com a fala da secretária: "não responda a isto" não é "não
leia isto".

### 4. O que cada pipeline espera de volta

| pipeline | resposta esperada | quem já trata |
|---|---|---|
| lembrete | "sim"/"não"/"remarcar" | `lembrete_confirmacoes.py`, às 17h |
| auto-resposta | nenhuma | — |
| nota fiscal | nenhuma (às vezes "obrigado") | — |
| avaliação | nenhuma (às vezes "feito", "avaliei") | — |
| lembrete de 1 ano | interesse em marcar | **ninguém ainda** |

⚠️ O lembrete de 1 ano é o único cujo retorno é **conversa de verdade**: quem
responde quer marcar. Ali a Lara DEVE atender — suprimir seria perder exatamente
a conversão que o pipeline existe para gerar. A supressão dele vale só para
"ok"/"obrigado", nunca para quem demonstra interesse.

## O que NÃO resolve

- Resposta que chega **dias** depois, fora da janela: vira conversa normal, sem
  contexto do pipeline. É o caso do `docs/SEMEAR-HISTORICO.md`.
- Paciente que responde ao lembrete com áudio: hoje o áudio já é transcrito no
  caminho normal (conserto de 22/10), mas "sim" falado pode não casar com o
  recorte de texto curto.

## Decisões que são do Thiago

1. **Janela por pipeline.** Lembrete: até o fim do dia seguinte? Nota fiscal e
   avaliação: 2 horas? Lembrete de 1 ano: nenhuma?
2. **O que fazer com a resposta suprimida.** Fica só no histórico, ou a recepção
   recebe um resumo (como o `lembrete_confirmacoes.py` já faz às 17h)?
3. **A lista de confirmações curtas** é configuração ou código? Configuração
   permite ajustar sem deploy; código a mantém sob teste.
