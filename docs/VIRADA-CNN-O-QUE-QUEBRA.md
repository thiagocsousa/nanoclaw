# A virada de segunda: o que quebra, por gravidade

Escrito em 25/10/2026 (domingo). **A equipe passa a usar a CNN amanhã.**

A pergunta deste documento é uma só: **no dia em que a clínica parar de lançar
no iClinic, o que cada pipeline faz?** Não "o que seria bom migrar" — o que
QUEBRA, e o que o paciente sente.

Os nove scripts leem o iClinic. Amanhã o iClinic continua de pé (até 20/11) mas
**congelado**: ninguém lança nada nele. Ler de lá deixa de ser "dado velho" e
passa a ser **dado errado**, porque a agenda de verdade está noutro lugar.

## Triagem

| # | pipeline | o que acontece segunda | gravidade |
|---|---|---|---|
| 1 | **`iclinic_marcar`** (Lara marca) | escreve num sistema que ninguém olha. O paciente ouve "está agendado" e **não está** | ⛔⛔ **o pior** |
| 2 | **`iclinic_vagas`** (Lara oferece) | lê a agenda congelada: horário ocupado na CNN aparece livre | ⛔⛔ **oferta em cima de consulta** |
| 3 | `lembrete_coletar` 15h | lê a agenda de amanhã no iClinic → vazia → **ninguém é lembrado** | ⛔ paciente falta |
| 4 | `nfse_coletar` 18h30 | lê o financeiro do iClinic → vazio → **nota não é emitida** | ⛔ fiscal |
| 5 | `marina-danfse` 19–21h | não tem nota para mandar | ⛔ (consequência do 4) |
| 6 | `lembrete_confirmacoes` 17h | resume confirmações que não existem | ⚠️ ruído |
| 7 | `lembrete_autoreply` | sem lembrete, não há o que responder | ⚠️ inerte |
| 8 | `iclinic_agenda_hoje` (avaliação Google) | nenhum atendido → não pede avaliação | ⚠️ para de funcionar calado |
| 9 | `iclinic_agenda_amanha` 20h | manda agenda vazia para a Marina | ⚠️ |
| 10 | `iclinic_paciente_por_telefone` | acha o cadastro ANTIGO; o novo está na CNN | ⚠️ identidade errada |
| 11 | `iclinic_retorno_anual` 13h | ✅ continua certo — lê 1 ano atrás, e isso está no iClinic | ok até 20/11 |
| 12 | `sla_monitor` | ✅ não toca o iClinic, lê o jsonl do WhatsApp | ok |
| 13 | ~~`iclinic_laudo_topografia`~~ → `laudo_topografia` | ✅ **resolvido de outro jeito**: parou de escrever. Monta o texto e a Marina cola — a CNN não tem API de prontuário | ok |

## O projeto Lara, em específico

A Lara é o único que **fala com o paciente em tempo real e escreve**. Os outros
erram para dentro; ela erra para fora.

Hoje ela faz três coisas contra o iClinic, e as três ficam erradas amanhã:

1. **Oferece horário** (`iclinic_vagas`) a partir da agenda congelada.
2. **Marca** (`iclinic_marcar`) onde ninguém vai ver.
3. **Reconhece o paciente** (`iclinic_paciente_por_telefone`) num cadastro que
   deixou de ser o vivo.

⛔ **A combinação 1+2 é a pior coisa que este sistema pode fazer.** Ela oferece
um horário que na CNN já tem gente, o paciente aceita, ela grava no iClinic, e
ninguém na clínica fica sabendo. No dia, dois pacientes aparecem para o mesmo
horário e a clínica não tem registro de um deles. Não há aviso, não há erro, não
há log vermelho — o sistema todo se comporta como se tivesse dado certo.

Para a Lara, portanto, **não existe "deixa como está até arrumarmos"**.

### O mínimo que a protege, por ordem de custo

| opção | o que a Lara faz | custo de implementar | risco residual |
|---|---|---|---|
| **A. Silenciar a marcação** | oferece nada, escala tudo para a secretária | minutos | ela vira recepcionista de recado; nenhum horário errado sai |
| **B. Ler CNN, escalar marcação** | oferece horário **certo**, mas quem marca é humano | horas | o horário pode ser tomado entre a oferta e a marcação — risco que já existe hoje |
| **C. Ler e marcar na CNN** | tudo como hoje, na fonte certa | o dia inteiro | depende de cadastro de paciente, `idPacienteConvenio`, tipo de consulta |

**Recomendo B para amanhã, com C durante a semana.** B tira o erro irreversível
(marcar no lugar errado) e mantém o que o paciente mais valoriza — receber um
horário que existe. E B é pré-requisito de C de todo jeito: a leitura é a mesma.

⚠️ C tem um detalhe que B não tem: marcar na CNN é **três escritas** (criar
paciente → associar convênio → marcar), sem transação. Isso precisa de
reentrância antes de ir ao ar, senão uma falha no meio duplica cadastro.

## A ordem para hoje

1. **Lara lê a CNN** (`iclinic_vagas` → disponibilidade da CNN). Resolve o #2.
2. **Lara não marca** (`iclinic_marcar` → escala). Resolve o #1.
3. **`lembrete_coletar` lê a CNN.** Resolve o #3 — e é o que o paciente sente
   primeiro, porque o lembrete das 15h é a mensagem mais esperada do dia.
4. **`nfse_coletar` lê orçamento APROVADO da CNN.** Resolve o #4. Pode escorregar
   um dia sem dano — nota se emite depois; horário errado, não.
5. O resto (agenda de amanhã, avaliação, identidade) na semana.

⚠️ **A agenda da CNN ainda não está pronta** para ser fonte de oferta: hoje ela
devolve 07:00–20:00 porque o Thiago abriu a grade para a migração, e há uma
*escala por data* subtraindo horários (sexta 30/10 tem ZERO agendamentos e só 6
slots livres). O passo 1 só vale depois que a grade estiver corrigida — e o
`conferir-agenda-cnn.py` é quem diz quando.

Enquanto a grade não fechar, a proteção é o passo 2 sozinho: **a Lara para de
marcar**. É o que impede o erro irreversível, e não depende de nada.

### ✅ Resolvido em 26/10/2026, e por outro caminho

A grade da CNN **não foi fechada** — decisão do Thiago: ela fica aberta, porque
é por ela que a secretária marca exame na quinta e cirurgia na terça. Quem
restringe consulta passou a ser a Lara, que intersecta a grade com
`JANELAS_DE_CONSULTA` (seg 08–12, qua 14–18, sex 08–12) na oferta **e** na
marcação. Dia sem grade continua sendo dia sem consultório, então viagem e
feriado atravessam sozinhos.

Com isso o `conferir-agenda-cnn.py` mudou de pergunta: de "a CNN bate com a
regra?" — que passou a responder "diverge" sempre, por desenho — para "a Lara
tem o que oferecer?". Ele só alarma quando um dia de consulta está ABERTO e
nada cai na janela (turno divergente), ou quando o horizonte inteiro está
vazio. Dia bloqueado é informação, não defeito.
