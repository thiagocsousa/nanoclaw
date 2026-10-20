# Observação: um ponto único de egresso

Plano escrito em 20/10/2026, depois do incidente descrito abaixo. A semana de
observação está **desligada** e não deve ser religada antes da Fase 1.

## O incidente

Com a observação ligada entre 19:20 e 20:48 de 20/10/2026, **13 mensagens
`"Só um instante."` chegaram a 5 pacientes reais**, a partir do número
principal da clínica. Nenhuma consulta foi marcada no iClinic (a trava de
`a47150bf` segurou). Nenhum outro texto vazou: a fila de revisão reteve
corretamente 5 respostas normais.

O pior caso: uma paciente escreveu que o olho estava irritado e doendo e
recebeu seis `"Só um instante."`, inclusive depois de "Obrigada" e de um emoji
de choro.

### Causa imediata

`src/index.ts:550`:

```ts
if (wantsRevisaoHumana(group.folder) && acaoDoTurno !== 'escalar') {
```

A exclusão de `escalar` está **correta para o modo revisão** — o humano já vai
ver o caso, segurar o "Só um instante." não acrescenta nada. **Em observação a
premissa inverte:** o objetivo é que nada chegue ao paciente, e aquilo é uma
mensagem ao paciente. E escalonamento é o desfecho MAIS COMUM de uma DM
desconhecida, então era o caminho principal, não borda.

### Causa estrutural

A política de observação é consultada **uma vez**, num ponto do fluxo
(`index.ts:550`), e as ações estão espalhadas antes e depois dele:

| Ação | Onde | Antes ou depois da trava |
|---|---|---|
| `setTyping` (paciente vê "digitando") | `index.ts:381`, `:865` | **169 linhas antes** |
| Escrita no iClinic | `executor.ts:1478` | antes (consertado em `a47150bf`) |
| Texto de escalonamento | `index.ts:613/621` | depois, mas a trava se exclui |
| Resposta normal | `index.ts:613/621` | depois, retida ✅ |

⚠️ **Enumerei os caminhos três vezes hoje e deu três resultados diferentes**,
cada um mais completo que o anterior. Nas duas primeiras eu afirmei estar
coberto. Isso é a razão principal para o desenho abaixo não depender de
enumeração correta.

## A invariante que falta

> Em observação, **nada originado do turno da Lara** alcança o paciente —
> texto, mídia, presença ou escrita externa — e **tudo originado dos pipelines
> da clínica** continua alcançando.

As duas metades importam. A segunda é o que impede o conserto de ser pior que o
problema.

## Por que bloquear por ALVO está errado

O bloqueio óbvio — "recusa qualquer envio cujo alvo seja DM de paciente em
observação" — quebra quatro pipelines que funcionam e não têm relação com a
Lara:

| Pipeline | Pasta | Origem |
|---|---|---|
| Lembrete de consulta (coleta 15h) | `atendimento-dra-marina` | `send_reminder` |
| Auto-resposta | `atendimento-dra-marina` | origem fixa |
| PDF da nota fiscal | `atendimento-dra-marina` | `send_nota` |
| Avaliação pós-consulta | `marina` | origem fixa |

Um paciente que escrevesse durante a semana deixaria de receber **o lembrete da
própria consulta**. Isso é pior que o incidente original.

## O desenho: bloquear por ORIGEM

O IPC já carrega origem (`data.origin`, conferido em `ipc.ts:58-68`). O caminho
do turno **não carrega nada** — é essa a lacuna real, e é a diferença entre um
`if` e um refactor.

### Fase 1 — fechar o vazamento, sem refactor

Objetivo: poder religar a observação com segurança medida. Não resolve a classe,
resolve os furos conhecidos, cada um com teste.

1. **`index.ts:550`** — a exclusão de `escalar` passa a valer só fora da
   observação:
   `wantsRevisaoHumana(folder) && (acao !== 'escalar' || emObservacao(folder, chatJid))`.
   O escalonamento continua notificando o humano; o que é recusado é a entrega
   ao paciente.
2. **`setTyping`** — `index.ts:381` e `:865` passam a consultar
   `emObservacao(folder, chatJid)`. O paciente não deve ver nem presença.
3. **Teste por furo**, com controle negativo: em observação nenhum envio e
   nenhuma presença para DM; fora dela, ambos acontecem.

Quebra: nada. Nenhum pipeline passa por `index.ts:550` nem pelo `setTyping` do
turno.

### Fase 2 — ponto único de egresso

Objetivo: caminho novo nasce barrado, em vez de nascer vazando.

1. Uma primitiva de entrega no canal (`entrega({ alvo, tipo, origem, carga })`)
   por onde passem **texto, imagem, documento, presença e o flush da fila**.
   ⚠️ Hoje `sendImage` (`whatsapp.ts:816`), `sendDocument` (`:879`) e o flush da
   reconexão (`:1068`) chamam `sock.sendMessage` **direto**, sem passar pelo
   `sendMessage` do canal — então travar só o `sendMessage` deixaria os três
   abertos. Foi o achado que derrubou o meu primeiro desenho.
2. A primitiva exige `origem` explícita. Quem envia pelo turno declara
   `origem: 'turno'`; os pipelines declaram a própria. Em observação, `'turno'`
   é recusado para alvo que seja DM, com log e auditoria.
3. O flush da fila precisa **preservar a origem** de cada item e reavaliar na
   reconexão — item enfileirado antes e entregue depois é o caso que nenhum
   `if` no fluxo pega.

Quebra: todo chamador de envio passa a precisar declarar origem. É mecânico,
mas é amplo, e um chamador esquecido falha fechado (melhor que o inverso).

### Fase 3 — autorização na fronteira de escrita

A trava do iClinic de hoje está no orquestrador, não na fronteira. `marca()` e
`escreveNoIclinic()` não recebem nem conferem contexto de observação, e **o
container do agente recebe `ICLINIC_EMAIL`/`ICLINIC_PASSWORD`**
(`container-runner.ts:127`) com os scripts da pasta montados. Então um prompt
diferente, uma regressão ou uma tarefa agendada alcançam `iclinic_marcar.py`
direto, e a escrita fantasma volta.

1. `marca()` exige autorização explícita e recusa alvo observado.
2. Em observação, **não encaminhar credencial de escrita** ao container de
   classificação. É a única trava que não depende de ninguém lembrar.

### Fase 4 — Remote Control

`index.ts:994` autoriza por `group?.isMain` e **nada mais**: não valida
remetente nem administração. Qualquer participante do grupo principal inicia
sessão, recebe a URL (inclusive de sessão ativa) ou encerra. Exposição pequena
mas aberta, e independente da observação.

## O que NÃO está medido, e não deve ser suposto

⚠️ **`amarracao: "sem_campo"` nas DMs reais.** Na passada de teste o agente
devolveu `id_mensagem` em **5 de 5** turnos; nas DMs de paciente reais devolveu
em **nenhum**. Sem amarração o host cai na mensagem mais nova, e foi isso que
produziu o "laço" observado — dois turnos a 2 segundos lendo a mesma mensagem e
emitindo o mesmo texto. Eu concluí "funcionou" a partir de cinco turnos num
grupo, e o comportamento com paciente real foi outro.

Medir antes de qualquer conserto de amarração: por que o campo sai no grupo e
não na DM. Hipóteses não testadas: sessão de agente reaproveitada, contexto
longo da DM, ou o prompt da DM não carregar o mesmo `CLAUDE.md`.

⚠️ E o Codex apontou que a amarração **falha aberta** por desenho meu: sem
correspondência única, o host usa a última mensagem em vez de recusar. Para
identidade de paciente, falhar fechado é o certo — decisão pendente.

## Um achado do review que NÃO se confirmou

O Codex classificou como alto que a observação registraria a DM como chat e
assim desarmaria o gate do IPC (`ipc.ts:66`, `if (isRegisteredChat) return false`).
Verificado: `registered_groups` tem 5 linhas, nenhuma DM de paciente, e nenhuma
pasta por DM foi criada. O registro de `registraDmEmObservacao` não persistiu,
então o gate continua bloqueando. **O mecanismo descrito é real; a precondição
não ocorreu.** Vale consertar na Fase 2 de todo modo, porque depende de um
acidente.

## Decisões que são do Thiago

1. **Escopo**: Fase 1 sozinha permite religar a observação com os furos
   conhecidos fechados. Fases 2 e 3 fecham a classe. Fase 1 é horas; 2 e 3 são
   maiores.
2. **Pipelines durante a observação**: lembrete, auto-resposta, nota e
   avaliação continuam falando com paciente observado? O plano assume **sim**
   (eles são da clínica, não da Lara).
3. **Falhar fechado na amarração**: sem `id_mensagem` único, recusar o turno e
   mandar para revisão, em vez de usar a última mensagem?
