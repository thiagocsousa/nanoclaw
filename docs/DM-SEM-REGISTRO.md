# A DM de paciente deixa de fingir que é um grupo

Plano escrito em 22/10/2026, depois do primeiro dia da semana de observação.
Não é pré-requisito da semana: é pré-requisito da **Lara assumir**.

## O problema

Para processar a DM de um paciente, o host hoje a **registra como se fosse um
grupo** (`registraDmEmObservacao`, em `index.ts`). O registro existe só para
reusar o `processGroupMessages`, que itera `registeredGroups`.

E ele está quebrado desde que nasceu:

```ts
registerGroup(chatJid, {
  jid: chatJid,
  name: chatJid,
  folder,
  triggerPattern: DEFAULT_TRIGGER,  // ⚠️ o tipo pede `trigger`
  requiresTrigger: false,           // ⚠️ e falta `added_at`
  isMain: false,
} as never);                        // ⚠️ o cast esconde os dois
```

`setRegisteredGroup` grava `group.trigger` em `trigger_pattern`, que é
`NOT NULL`. O resultado é `SqliteError: NOT NULL constraint failed:
registered_groups.trigger_pattern`, 17 vezes no log.

**Por que ainda assim funciona:** `registerGroup` faz
`registeredGroups[jid] = group` **antes** de `setRegisteredGroup` lançar. O mapa
em memória recebe a DM, o banco não. Os turnos acontecem; nada persiste; o
reinício esquece tudo.

## Por que o conserto óbvio é PIOR que o defeito

Corrigir só o nome do campo faria o insert passar — e aí três coisas quebram.

### 1. `folder` é UNIQUE, e o insert é `INSERT OR REPLACE`

```sql
folder TEXT NOT NULL UNIQUE
INSERT OR REPLACE INTO registered_groups (jid, name, folder, ...)
```

Toda DM observada usa a MESMA pasta (`dmObservacaoFolder`). O primeiro insert
colide no `folder` com a linha do grupo de atendimento e o `REPLACE`
**apaga o grupo**. Depois, cada paciente novo apaga o anterior.

### 2. Registrar DESARMA o gate de DM do IPC

```ts
// ipc.ts:58
function patientDmBlocked(sourceGroup, chatJid, origin, isRegisteredChat) {
  if (!DM_GATED_FOLDERS.has(sourceGroup)) return false;
  if (!chatJid.endsWith('@s.whatsapp.net')) return false;
  if (isRegisteredChat) return false;   // ⬅️
  return !(typeof origin === 'string' && DM_ALLOWED_ORIGINS.has(origin));
}
```

É a trava que impede o agente de mandar mensagem a paciente por IPC sem origem
de script. O Codex apontou isso em 20/10; verificado na época, a precondição não
ocorria — **porque o registro falhava**. Consertar o registro sem mais nada
transforma um achado teórico em buraco real.

### 3. `pasta → grupo` deixa de ser único

Duas resoluções assumem unicidade:

| onde | o que faz |
|---|---|
| `task-scheduler.ts:116` | `Object.values(groups).find((g) => g.folder === task.group_folder)` |
| `ipc.ts` (6 pontos) | `targetGroup.folder === sourceGroup` |

Com N pacientes na mesma pasta, o `find` devolve **o primeiro que aparecer**, e
uma tarefa agendada da clínica pode disparar na DM de um paciente qualquer.

## As três saídas, e por que duas caem

**A — uma pasta por DM.** Satisfaz o esquema e mantém `pasta → grupo` único.
⛔ Mas `templates.json` e `CLAUDE.md` são POR PASTA, e `TEMPLATE_FOLDERS` é uma
lista: seria copiar os textos aprovados da Marina uma vez por paciente. Editar
um e esquecer os outros é questão de tempo, e texto ao paciente é o que esta
arquitetura existe para manter sob controle. **Descartada.**

**B — derrubar a UNIQUE.** É o modelo natural: todos os pacientes compartilham
persona, textos e pasta, e o estado por conversa já é indexado por `chatJid`
dentro dela (`leOfertas(folder)[chatJid]`, `chaveDaSessao(folder, chatJid)`).
⛔ Mas exige migração de esquema E auditar os 7 lookups de `pasta → grupo`
acima, antes de ligar. **Possível, cara.**

**C — não registrar.** O registro só existe para reusar o laço. A informação
"esta DM pertence a esta pasta" **já existe, explícita**, em
`pastaDeObservacaoDeDm`. **Escolhida.**

## O desenho da C

> Uma DM observada é um **chat com pasta conhecida**, não um grupo registrado.
> `registered_groups` volta a significar "chats que a clínica possui".

### A peça nova

Um registro leve de DMs observadas, persistido junto do estado que já existe
(`lastAgentTimestamp` / `saveState`), com dois campos por DM: **pasta** e
**cursor**. Não vai para `registered_groups` e não tem `trigger_pattern`.

### Os pontos de mudança

| # | onde | o quê |
|---|---|---|
| 1 | `index.ts` — `const jids = Object.keys(registeredGroups)` | passa a ser `grupos ∪ dmsObservadas` |
| 2 | `index.ts` — `const group = registeredGroups[chatJid]; if (!group) continue;` | resolver `grupoDoChat(chatJid)`, que devolve o grupo registrado OU um descritor sintético da DM (pasta da config, `requiresTrigger: false`, `isMain: false`) |
| 3 | `index.ts` — `processGroupMessages` | mesma resolução; o resto do corpo não muda |
| 4 | `index.ts` — `registraDmEmObservacao` | some. Fica só a semeadura do cursor (`lastAgentTimestamp[chatJid] = desdeIso`), que é o que impede a primeira rodada de varrer o histórico |
| 5 | `channels/whatsapp.ts` — a chamada no laço de observação | passa a `registraDmObservada(chatJid, folder, desdeIso)`, sem `registerGroup` |
| 6 | `index.ts` — `registeredGroups[chatJid]` do gate de allowlist | usa o mesmo resolvedor, de modo que a **DM observada ENTRA** no descarte por remetente (decisão do Thiago, 22/10/2026 — ver abaixo) |
| 7 | `ipc.ts` — `patientDmBlocked` | **nada muda, e é o ponto** — a DM continua não registrada, então o gate continua armado |
| 8 | `task-scheduler.ts:116`, `ipc.ts` (6 pontos) | **nada muda** — a pasta continua pertencendo a um grupo só |

### O que isso dá, além de destravar

- **Sobrevive a reinício.** Hoje o mapa em memória se perde e a DM é
  "redescoberta" na mensagem seguinte, com o cursor refeito.
- **Para de mentir.** `registered_groups` hoje tem linhas que o código acha que
  existem e o banco nunca aceitou.
- **O gate do IPC continua armado**, de propósito e não por acidente.

### O que NÃO resolve

- A `UNIQUE` em `folder` continua lá. Se um dia a clínica quiser duas pastas
  para o mesmo canal, é a opção B de novo.
- `registraDmEmObservacao` lançando hoje é o que **aborta o lote inteiro** no
  `catch` do laço — com a C ele deixa de existir, mas vale um teste de que uma
  falha num item não derruba os outros.

## Decidido: a DM entra na allowlist (ponto 6)

Decisão do Thiago em 22/10/2026. O gate do descarte por remetente é hoje

```ts
if (!msg.is_from_me && !msg.is_bot_message && registeredGroups[chatJid]) {
```

e, com a C, `registeredGroups[chatJid]` vira o resolvedor — que inclui a DM
observada. Uma condição, nenhuma mudança de comportamento hoje.

**Por quê.** Não existe `sender-allowlist.json` nem no repo nem na VM, então
vale o padrão `{ allow: '*', mode: 'trigger' }` e ninguém está bloqueado. A
alternativa (deixar a DM de fora) não economizaria nada e cobraria depois: no
dia em que um número insistir de madrugada ou abusar, a alavanca não alcançaria
DM e seria preciso código novo. Com a decisão, basta o arquivo:

```json
{ "chats": { "5586XXXXXXXXX@s.whatsapp.net": { "allow": [], "mode": "drop" } } }
```

⚠️ O modo que resolve esse caso é `drop`, não `trigger`. Em DM de paciente o
`requiresTrigger` é `false` — toda mensagem já dispara turno, com ou sem
`@Andy` —, então o modo `trigger` da allowlist nunca é consultado ali. Quem
quiser bloquear um número precisa de `drop`, que descarta antes de gravar.

## Decisões que são do Thiago

1. **Quando fazer.** Não bloqueia a semana (os turnos acontecem pelo mapa em
   memória). Bloqueia a Lara assumir. Sugiro com a semana rodando, e depois de a
   imitação de aprovação da suíte voltar a funcionar — senão a passada não
   consegue cobrir a mudança.
2. **Limpeza das DMs observadas.** Elas acumulam no estado. Expira por tempo
   (ex.: 7 dias sem mensagem) ou fica para sempre?
