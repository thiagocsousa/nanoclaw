# Semear o histórico das conversas que começaram antes da captura

Plano escrito em 22/10/2026, depois de um caso real do primeiro dia útil da
semana de observação. **Implementado** em 22/10/2026
(`src/semear-historico.ts`); o plano foi escrito antes do código porque a parte
perigosa — o cursor — é fácil de errar sem perceber.

## O caso

```
20/10 13:47  clínica    Deixa só eu verificar com a dra sobre o seu caso, e…
21/10 17:20  paciente   Boa tarde, a Dra deu algum retorno?
21/10 20:21  paciente   Boa tarde, veja a possibilidade de fazermos a cirurg…
22/10 12:15  paciente   Bom dia
22/10 12:15  paciente   Tem algum retorno?
```

A Lara respondeu *"Sim. O retorno está incluído em até 30 dias, quando for
necessário"* — a pessoa perguntava pela **resposta da médica**, pela terceira
vez em dois dias, e recebeu a regra do retorno de consulta.

A resposta está certa para a pergunta que ela viu e errada para a pergunta que
foi feita. **O banco da Lara tem 3 mensagens dessa conversa; a conversa tem
114.** A captura começou às 10:58 de hoje e o cursor nasce na mensagem que
descobre a DM — "só mensagens novas" (Thiago, 19/10/2026), que é o certo para
não varrer histórico, e é o que deixa a conversa sem passado.

⚠️ **Isto não é um defeito de um caso: é o estado de TODAS as conversas
anteriores a hoje.** Enquanto a semana roda, a Lara parece pior do que é
exatamente nas conversas mais longas — as que já vinham com assunto pendente.

## A fonte que existe

`groups/whatsapp_atendimento-dra-marina/atendimento_sla.jsonl`, medido hoje:

| | |
|---|---|
| eventos | 3.260 |
| período | 01/10 11:02 → 22/10 12:15 |
| conversas | 201 |
| com `id` e com `text` | 3.260 (100%) |
| direções | 1.668 `out` / 1.592 `in` |
| maior conversa | 150 eventos |
| arquivo | 892 KB |

Tem o que falta: **os dois sentidos desde o começo**, com `id`, `timestamp`,
`jid`, `direction`, `push_name` e `text`.

⚠️ E tem o que NÃO tem: mídia é marcador. 73 `[áudio]`, 53 `[documento]`, 47
`[imagem]`, 11 `[sticker]`. Histórico semeado tem buraco onde houve áudio — e
áudio é justamente onde o paciente explica caso.

## O desenho

> Semear é **inserir passado**, não processar presente. A regra que governa tudo
> é: nada do que for semeado pode virar turno.

### 1. O cursor primeiro, a inserção depois

⛔ É a ordem que decide se isto é seguro ou é um desastre. Inserir 150 mensagens
numa conversa cujo cursor está atrás faz o host considerar todas "novas": o
laço monta um prompt com a conversa inteira e **responde**. Em observação a
resposta ficaria retida — mas seriam 201 conversas de uma vez, e a fila da
revisão viraria lixo. Com a Lara assumindo, seria mensagem a paciente.

Então, por conversa: gravar `lastAgentTimestamp[chatJid]` = timestamp do ÚLTIMO
evento semeado **antes** de inserir qualquer linha, e `saveState()` na mesma
transação lógica.

⚠️ `getOrRecoverCursor` tem um fallback que ajuda aqui e precisa ser conferido:
sem cursor, ele tenta o último "bot message" do chat. Semear mensagens `out` da
clínica pode fazê-lo recuperar um cursor que não é o que queremos.

### 2. Idempotência pelo `id`

`storeMessage` já faz `INSERT OR REPLACE` pela chave `id`, e o log tem `id` em
100% dos eventos. Rodar o semeador duas vezes não duplica — **desde que o `id`
do log seja o mesmo `key.id` que a captura usa**. Conferir antes: um id
diferente faria cada rodada duplicar a conversa inteira.

### 3. O que cada evento vira

| campo do log | campo da mensagem |
|---|---|
| `id` | `id` |
| `jid` | `chat_jid` |
| `direction: 'in'` | `is_from_me: false`, `sender: jid` |
| `direction: 'out'` | `is_from_me: true`, `sender: 'clinica'` |
| `push_name` | `sender_name` |
| `text` | `content` |
| `timestamp` | `timestamp` |

`is_bot_message: false` em tudo: nada ali foi escrito pela Lara, e marcar como
bot esconderia o histórico de `getNewMessages` — que é o que queremos — pelo
motivo errado. Quem impede o turno é o cursor, não uma mentira no campo.

### 4. Escopo e teto

- Só JIDs que **já estão** em `dms_observadas`. Semear as 201 conversas traria
  para o banco gente que nunca mais escreveu, e parceiros.
- Teto por conversa (ex.: 50 eventos ou 30 dias, o que vier primeiro). A maior
  tem 150; prompt com 150 mensagens é caro e provavelmente pior que com 30.
- Uma vez por conversa, na primeira vez que ela é vista. Não é job periódico.

## O que isto NÃO resolve

- **Áudio semeado continua sendo `[áudio]`.** O `.ogg` daquelas conversas não
  foi baixado na época; não há o que transcrever. Buraco permanente no passado.
- **Mensagem apagada ou editada** no WhatsApp está no log como estava.
- **Só alcança o que o SLA viu**: começa em 01/10, e só o número do atendimento.

## O risco que me preocupa mais

Não é técnico. É que **semear muda o que a semana mede**: parte das respostas
passa a vir de histórico importado, e a Marina não tem como saber, lendo a fila,
se a Lara acertou com o contexto que teria em produção ou com um contexto que
só existe porque eu importei. Se formos semear, a fila precisa **marcar** quais
conversas foram semeadas.

## Decisões que são do Thiago

1. **Semear ou descontar na leitura?** A opção barata (marcar no relatório quais
   conversas entraram sem passado) não conserta a resposta errada, mas também
   não mistura as fontes. Semear conserta e mistura.
2. **Teto por conversa**: 50 eventos? 30 dias? Os dois?
3. **Quando.** Fora do expediente, e com a semana pausada ou não? Semear com
   paciente escrevendo significa cursor e captura disputando a mesma conversa.

## Depois do review adversarial (Codex, 22/10/2026)

A semeadura gravava cursor e histórico na transação dela, e o registro da DM em
`dmsObservadas` vinha depois, num `saveState` separado. Morrer entre os dois
deixava um estado incoerente: **semeado e não acompanhado** — cursor e
histórico no banco, chat fora do conjunto que o laço varre.

Agora as três coisas — cursor, linhas do histórico e registro da DM — estão na
**mesma** transação, e a leitura do log de SLA (`historicoParaSemear`) está
separada da escrita. Falha de leitura segue sem passado; falha de escrita
cancela tudo.

⚠️ **A janela encurta, não fecha.** A linha da mensagem que descobriu a DM é
gravada pelo `onMessage` do canal, depois deste callback retornar, e não cabe
nesta transação sem reestruturar o canal. O que resta se cura na mensagem
seguinte do paciente: ela redescobre a DM e semeia a anterior como contexto.
