# Migração iClinic → Clínica nas Nuvens

Análise e plano escritos em 24/10/2026. **Não implementado.**

⏳ **Prazo: o iClinic fica de pé até 20/11/2026.**

O plano existe porque a decisão de ordem é mais importante que o código: a
leitura da agenda é o que decide se um horário é oferecido ao paciente, e errar
essa leitura não dá erro — dá horário oferecido em cima de consulta marcada.

## 1. O que existe hoje

Nove scripts falam com o iClinic. Todos pelo mesmo mecanismo:

> **O Playwright só serve para fazer login e pegar o cookie.** Os dados vêm de
> `page.request.get/post()` contra endpoints JSON **internos e não
> documentados** do iClinic. É um cliente de API privada vestido de navegador.

```
sync_playwright() → Chromium → preenche input[name=email]/password
  → pega o cookie `csrftoken`
  → headers = {"X-Requested-With": "XMLHttpRequest", "X-CSRFToken": csrf}
  → page.request.get("https://app.iclinic.com.br/agenda/...")
```

Esse bloco de ~20 linhas está **copiado em 9 scripts**. Não há módulo comum.

### Os pipelines e o que cada um precisa do sistema da clínica

| pipeline | cron | o que faz no iClinic | capacidade |
|---|---|---|---|
| `iclinic_vagas.py` | sob demanda (Lara) | lê a agenda, calcula vagas | **ler agenda** |
| `iclinic_marcar.py` | sob demanda (Lara) | `POST /agenda/criar-evento/` | **escrever consulta** |
| `iclinic_paciente_por_telefone.py` | sob demanda (Lara) | busca paciente por telefone | **buscar paciente** |
| `lembrete_coletar.py` | 15:00 seg-sex | lê a agenda do próximo dia útil | ler agenda |
| `iclinic_agenda_hoje.py` | 10,12,14,16,18,19h | lê os atendidos de hoje | ler agenda |
| `iclinic_agenda_amanha.py` | 20:00 dom-qui | lê a agenda de amanhã | ler agenda |
| `iclinic_retorno_anual.py` | 13:00 diário | lê atendidos de 1 ano atrás | ler agenda (data passada) |
| `nfse_coletar.py` | 18:30 seg-sex | `GET /financas/busca/` + `GET /pacientes/{id}/` | **ler financeiro** + **ler cadastro** |
| `iclinic_laudo_topografia.py` | sob demanda | digita o laudo no prontuário | **escrever prontuário** |

São **seis capacidades**, não nove integrações. É assim que a migração deve ser
pensada.

### Endpoints em uso

| verbo | endpoint | quem usa |
|---|---|---|
| GET | `/agenda/{PHYSICIAN_ID}/{YYYY-MM-DD}/?clinic={CLINIC_ID}&slide=1` | 6 scripts |
| POST | `/agenda/criar-evento/{PHYSICIAN_ID}/` | `iclinic_marcar.py` |
| GET | `/pacientes/{id}/` | `nfse_coletar.py` |
| GET | `/financas/busca/…` | `nfse_coletar.py` |
| — | DOM (`keyboard.type`) | `iclinic_laudo_topografia.py` |

⚠️ O GET da agenda devolve a **semana inteira**, não o dia. `iclinic_vagas.py`
tem cache em cima disso porque sem ele um horizonte de 2 semanas custaria ~13
requests sequenciais e estouraria o teto de 180 s do agent-runner. **Se a API da
CNN devolver por dia, esse cálculo muda e o teto volta a ser um risco.**

### O conhecimento tácito que não está em nenhuma API

Isto é o que mais custa na migração, porque não se descobre lendo documentação —
foi medido no sistema real:

| coisa | onde está | o que é |
|---|---|---|
| `CONVENIOS` | `iclinic_marcar.py:56` | ids numéricos de convênio |
| `PROCEDIMENTOS` | `iclinic_marcar.py:65` | ids numéricos de procedimento |
| `CONVENIO_DO_PERFIL` | `iclinic_marcar.py:75` | qual convênio cada perfil cobra |
| `STATUS_LIVRE = {ca, fl, na}` | `iclinic_vagas.py:96` | status que contam como horário LIVRE |
| `STATUS_EXCLUIR = {ca, fl, na, bl, hd}` | `lembrete_coletar.py:42` | status que não geram lembrete |
| `cp` | 8 lugares | compareceu — base do retorno anual e da avaliação |
| `sc` | `iclinic_marcar.py` | status com que a consulta é criada |
| tipos do payload | `iclinic_marcar.py:323` | `procedure_id`/`insurance` são **número**, `physician`/`clinic` são **string**, vazios são `null` e não `""` |

`CLINIC_ID = 263255` e `PHYSICIAN_ID = 284806` estão **cravados como default** no
código (`os.environ.get("ICLINIC_CLINIC_ID", "263255")`) e **não** estão em
`FORWARDED_ENV_VARS` — ou seja, hoje o default é que vale.

## 2. A boa notícia: a costura já existe

Os scripts falam com o host por **stdout JSON** (`{"wakeAgent": …, "data": …}` /
`{"ok": …}`), e o host os invoca por `rodaScript`/`montaArgs`
(`src/script-container.ts`). Toda a lógica de produto — classificador,
templates, executor, oferta, revisão humana, SLA — está **acima** dessa linha e
**não sabe** que existe iClinic.

> **A migração cabe inteira abaixo da fronteira do script.** Se o contrato de
> stdout for preservado, `src/` não muda em nada.

O que também **não** é do iClinic e deve sobreviver intacto: o cálculo de
ocupação e vagas, o teto da Unimed, o travamento de dia, a conferência de
identidade antes de marcar (nome + nascimento), a camada ABRASF/DPS da NFS-e, e
o cache de agenda.

## 3. O que a API da CNN precisa oferecer

Derivado das seis capacidades. **Cada linha é uma pergunta a responder na
documentação antes de escrever código**, e três delas são bloqueantes.

| # | capacidade | pergunta | bloqueante? |
|---|---|---|---|
| 1 | ler agenda | eventos de um período, com **status**, paciente e procedimento? granularidade dia ou semana? | **sim** |
| 2 | escrever consulta | criar agendamento com convênio + procedimento + paciente novo *ou* existente? | **sim** |
| 3 | buscar paciente | por telefone **e** por nome+nascimento? | **sim** |
| 4 | ler cadastro | CPF/CNPJ, endereço e **CEP** (sem CEP a NFS-e falha com `L999`) | sim p/ NF-e |
| 5 | ler financeiro | o que foi cobrado no dia, por paciente | sim p/ NF-e |
| 6 | escrever prontuário | laudo em texto no prontuário do paciente | não |

Mais quatro perguntas transversais:

- **Autenticação**: token fixo, OAuth, ou chave por requisição? (Se for token
  fixo, o Playwright sai de cena por completo — e aí cai o Chromium do
  container, que é a maior parte da imagem.)
- **Limite de taxa**: o `marina-sla-monitor` roda a cada 5 min e o
  `lembrete_autoreply` também. Qual o teto?
- **Ambiente de teste**: existe sandbox? Sem ele, validar escrita significa
  marcar consulta de verdade na agenda da Marina.
- **Os ids**: convênios e procedimentos da CNN são enumeráveis pela API, ou
  precisam ser lidos da tela como foi no iClinic?

## 4. O plano

### Fase 0 — um cliente só, com o iClinic por dentro (não depende da CNN)

Extrair o bloco de login+headers duplicado nos 9 scripts para
`groups/_comum/clinica.py`, com uma interface pelas seis capacidades:

```python
class Clinica(Protocol):
    def agenda(self, de: date, ate: date) -> list[Evento]: ...
    def marca(self, consulta: Consulta) -> Marcacao: ...
    def paciente_por_telefone(self, tel: str) -> Paciente | None: ...
    def paciente(self, pid: str) -> Paciente: ...
    def financeiro_do_dia(self, d: date) -> list[Cobranca]: ...
    def escreve_laudo(self, pid: str, texto: str) -> None: ...
```

`Evento`, `Paciente` e `Cobranca` são **nossos**, não os do iClinic: é aqui que
os status viram nomes (`livre`, `compareceu`, `bloqueado`) e os ids viram
perfis. Traduzir na borda é o que impede o vocabulário do fornecedor de vazar
para o resto.

**Verificável sem a CNN**: roda contra o iClinic e tem de dar o mesmo resultado
de hoje. Nove cópias viram uma. Paga-se mesmo que a migração atrase.

### Fase 1 — mapear a CNN (precisa das credenciais e da doc)

Preencher a tabela da seção 3. Deliverable: um `docs/CNN-MAPEAMENTO.md` com
endpoint, payload e resposta real de cada capacidade, **medidos contra a API**,
e a tabela de equivalência dos status e dos ids. Nada de código ainda.

⛔ Se a capacidade 1, 2 ou 3 não existir ou vier incompleta, o plano para aqui e
a conversa muda — não há migração parcial que mantenha a Lara marcando consulta.

### Fase 2 — segunda implementação, e leitura em sombra

`ClinicaCNN` implementando o mesmo protocolo, escolhida por env
(`CLINICA_BACKEND=iclinic|cnn`), com um terceiro modo: **`sombra`**.

Em sombra, toda **leitura** chama os dois, usa a resposta do **iClinic** e loga
a divergência. Zero risco para o paciente, e é a única forma honesta de validar
leitura contra clínica em operação: a agenda muda o dia todo, então comparar
dumps manuais não prova nada.

Rodar em sombra por uma semana. O critério de passagem é **zero divergência de
ocupação** em dia útil — não "poucas". Horário oferecido em cima de consulta
marcada é o erro que não se pode cometer.

### Fase 3 — virar a leitura, depois a escrita

Leitura primeiro (`CLINICA_BACKEND=cnn`), com o iClinic ainda vivo para rollback
por env. Depois a escrita, **uma por vez**, na ordem de risco crescente:

1. `nfse_coletar` (lê financeiro; erro = nota errada, corrigível)
2. `lembrete_coletar` / `agenda_*` / `retorno_anual` (leitura pura)
3. `paciente_por_telefone` (leitura, mas alimenta a identidade da marcação)
4. `iclinic_marcar` (**escreve na agenda** — por último, e com `--dry-run`
   primeiro, que o script já tem)

### Fase 4 — o laudo de topografia

É o único que não é API: digita no DOM com `keyboard.type`, porque preencher por
JS não funciona no editor do iClinic. Se a CNN tiver API de prontuário, ele
melhora; se não tiver, ele continua Playwright e fica como o último usuário do
Chromium no container. **Decidir depois, sem bloquear o resto.**

## 5. O que pode dar errado, e o que já sabemos

| risco | por que é real | mitigação |
|---|---|---|
| agenda por dia em vez de semana | o cache de `iclinic_vagas` existe por causa do teto de 180 s do agent-runner | medir na Fase 1; se for por dia, paralelizar ou subir o teto |
| status sem equivalente | `{ca, fl, na, bl, hd}` são 5 estados de "não é consulta valendo"; se a CNN tiver 3, a ocupação muda | tabela de equivalência explícita na Fase 1, revisada pela Marina |
| ids de convênio/procedimento | foram **lidos da tela** no iClinic, não de uma API | se a CNN não enumerar, o mesmo trabalho manual — e o script tem de avisar quando um id deixa de existir, como o atual já faz |
| sem sandbox | validar escrita = marcar consulta real | usar o `--dry-run` que já existe, e a primeira escrita real em horário fora de atendimento, conferida à mão |
| dois cadastros de credencial | hoje são duas contas (`ICLINIC_*` e `ICLINIC_CONSULTORIO_*`) | confirmar se a CNN precisa das duas |
| o Chromium sai da imagem | se a autenticação for por token, o container encolhe muito — mas o laudo (Fase 4) pode ser o único a ainda precisar dele | não remover o Chromium antes da Fase 4 estar decidida |

**Dois achados colaterais, independentes da migração:**

1. `ICLINIC_CLINIC_ID`/`ICLINIC_PHYSICIAN_ID` não estão em `FORWARDED_ENV_VARS`,
   então os **defaults cravados no código** é que valem. Na CNN isso deve nascer
   como env de verdade.
2. As duas tarefas ad-hoc do `whatsapp_main` (análise de campanhas Meta) têm o
   **token do Meta Ads em texto aberto** dentro do prompt, na tabela
   `scheduled_tasks` do banco de produção. Nada a ver com a clínica, mas é a
   regra de credenciais do projeto sendo quebrada num lugar que nenhum PR
   revisou, porque foram criadas em runtime.

## 6. Decidido em 24/10/2026

**O histórico NÃO vem.** O `retorno_anual` fica cego por 12 meses, e o Thiago
aceitou o custo.

⚠️ Mas a cegueira tem de ser **audível**. Hoje o script imprime
`"Nenhuma consulta atendida em {data}"` tanto quando ninguém foi atendido quanto
quando o sistema não tem dado algum para aquela data
(`iclinic_retorno_anual.py:138`). Durante 12 meses esses dois fatos ficam
indistinguíveis, e o segundo lê como um dia tranquilo. O script precisa dizer
`"data anterior ao início deste sistema"` — senão, quando a cegueira acabar e
ele voltar a não achar ninguém, ninguém vai saber se é verdade.

**O iClinic fica de pé até 20/11/2026**, e a marcação continua nele por
enquanto.

### ⛔ A consequência que isso tem, e que não é escolha nossa

Leitura e escrita da AGENDA são **inseparáveis**. Ler da CNN e escrever no
iClinic produz exatamente o erro que este plano existe para evitar:

```
Lara lê a agenda da CNN      → horário parece livre
Lara marca no iClinic        → a consulta não existe na CNN
Lara lê a CNN de novo        → horário AINDA parece livre
                             → oferece de novo → consulta dobrada
```

E vale também pelo outro lado: se a secretária marca na CNN enquanto a Lara lê
do iClinic, a Lara não vê o que ela marcou. Mesmo erro, direção oposta.

> **A Lara tem de ler e escrever o MESMO sistema que a equipe da clínica está
> usando.** O pivô não é nosso: ele segue a virada da clínica.

Isso reordena o plano. A Fase 3 deixa de ser "leitura primeiro, escrita depois"
para a agenda: as duas viram **juntas**, no dia em que a equipe virar. O que
pode migrar antes, de forma independente, é só o que não alimenta decisão de
horário:

| capacidade | pode virar antes? |
|---|---|
| ler agenda + escrever consulta | **não** — viram juntas, com a equipe |
| ler financeiro + ler cadastro (NF-e) | só quando a cobrança passar a ser lançada na CNN |
| buscar paciente | sim, se a base de pacientes for migrada antes |
| escrever prontuário (laudo) | sim, independente |

### A equipe migra ANTES de 20/11 (decidido em 24/10)

Então **20/11 não é o prazo** — é só quando o iClinic apaga a luz. O prazo real
é o dia em que a secretária começa a marcar na CNN, e **a Lara tem de virar no
mesmo dia**, pelo que está na caixa acima.

### ⛔ Isso muda o que a Fase 0 significa

Virar no mesmo dia que a equipe só é possível se a virada for **uma chave**, não
um mutirão de código. Hoje são nove scripts com nove cópias do login: virar isso
em um dia, com a clínica atendendo, é o tipo de coisa que se faz uma vez e se
conta para sempre.

> A Fase 0 deixa de ser "boa prática que se paga sozinha" e passa a ser **o que
> torna a virada de um dia possível**. Ela está no caminho crítico.

Com ela pronta, o dia da virada é `CLINICA_BACKEND=cnn` + restart. Sem ela, é
editar nove arquivos sob pressão.

E ela não depende de nada da CNN: pode começar hoje, e é verificável contra o
iClinic — tem de dar o mesmo resultado de hoje.

### O que falta

1. **A data da equipe.** É o prazo real de tudo.
2. **A doc e as credenciais da CNN** (por OneCLI, não por chat) para a Fase 1.
3. **O laudo de topografia**: API, Playwright de novo, ou manual?
4. **Quem confere a tabela de status e de convênios.** Eu derivo a proposta da
   doc, mas quem sabe se "bloqueado" da CNN é o `bl` do iClinic é a clínica.

### O que a sombra ainda consegue fazer

A Fase 2 continua valendo, mas com o alvo ajustado: enquanto a equipe estiver no
iClinic, a agenda da CNN está legitimamente vazia, então comparar ocupação não
prova nada. O que a sombra valida nessa janela é a **mecânica** — autenticação,
paginação, parsing, tradução de status — contra as consultas que a própria
equipe for lançando na CNN durante o treinamento. Concordância de ocupação só é
mensurável depois que a equipe virar, e aí já é tarde para ser portão.

⚠️ Isto é uma perda real de garantia, e vale dizer em voz alta: **a virada da
agenda não vai ter validação de concordância em produção antes de acontecer.** O
que sobra como rede é o `--dry-run` do `iclinic_marcar.py`, a conferência de
identidade que ele já faz, e um primeiro dia acompanhado à mão.
