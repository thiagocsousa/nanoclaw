# Mapeamento da API Clínica nas Nuvens

Medido contra a API real em 24/10/2026, não lido da documentação.
Base: `https://api.clinicanasnuvens.com.br` · Swagger: `/v2/api-docs` (55 endpoints).

⚠️ **Credenciais não ficam neste arquivo.** `client_id`, `client_secret` e o
token `clinicaNasNuvens-cid` vão para o OneCLI e entram por
`FORWARDED_ENV_VARS`. Elas foram compartilhadas por chat em 24/10 — **rotacionar
depois da virada** ("Alterar token" na tela de integrações).

## Autenticação — validada

```
curl -u "<client_id>:<client_secret>" \
     -H "clinicaNasNuvens-cid: <token>" \
     https://api.clinicanasnuvens.com.br/info     → 200
```

Basic auth + header. **Sem navegador.** O Playwright sai de cena para tudo que
é API — e com ele o Chromium do container, exceto pelo laudo (ver lacuna 3).

- **Limite: 120 requisições por minuto, por token.** Hoje o pico é o
  `sla_monitor` + `lembrete_autoreply`, ambos a cada 5 min: folgado.
- Datas `yyyy-MM-dd`, horas `HH:mm:ss`, páginas começam em 0.

## A clínica, pela própria API (`GET /info`)

| campo | valor |
|---|---|
| nome | LUMIS OFTALMOLOGIA |
| CNPJ | 63.521.918/0001-04 |
| horário | **08:00 – 18:00** |
| executor | `163882` — MARINA COSTA CARVALHO DE SOUSA (único) |

⚠️ O `EXPEDIENTE` do NanoClaw é **07:30 – 18:30**. São dois horários diferentes
para a mesma clínica, e agora existem nos dois sistemas. Decidir qual manda.

## As seis capacidades

| # | capacidade | endpoint | estado |
|---|---|---|---|
| 1 | ler agenda | `GET /agenda/lista?dataInicial&dataFinal` | ✅ melhor que o iClinic: período de verdade, não fatia de semana |
| 2 | escrever consulta | `POST /agenda/novo` | ✅ |
| 3 | buscar paciente | `GET /paciente/lista` | ⚠️ **sem filtro por telefone** |
| 4 | ler cadastro | `GET /paciente/{id}` | ✅ tem `cpfcnpj`, `endereco`, `contato` |
| 5 | ler financeiro | `GET /orcamento/lista` | ⚠️ só orçamento — **não é o financeiro do dia** |
| 6 | escrever prontuário | — | ❌ **não existe na API** |

Brindes que o iClinic não tinha:

- `GET /executor-agenda/disponibilidade?idExecutorAgenda&data&dataFim` — a
  própria API calcula disponibilidade. Pode substituir parte do `iclinic_vagas`.
- `GET /executor-agenda/{id}/proxima-disponibilidade`
- `POST /agenda/{id}/remarcar` e `PUT /agenda/alteracao-status` — remarcar e
  cancelar viram operações de primeira classe.
- `POST /lista-espera/novo` — lista de espera.

## Os catálogos, lidos da API (substituem os ids cravados no código)

**Convênios** (`GET /tipo-convenio/lista`):

| id | nome | particular |
|---|---|---|
| 74546 | IASPI | não |
| 74545 | IPMT | não |
| 74466 | PARTICULAR | **sim** |
| 74543 | PARTICULAR DESCONTO | **sim** |
| 74544 | UNIMED | não |

**Procedimentos** (`GET /tipo-procedimento/lista`): 8 ativos —
`1212102 CONSULTA OFTALMOLÓGICA`, `1212181 TOPOGRAFIA DE CÓRNEA`,
`1212182 MAPEAMENTO DE RETINA`, `1212183 YAG CAPSULOTOMIA`,
`1212184 CIRURGIA CATARATA`, `1212185 CIRURGIA PRK`, `1212186 CIRURGIA LASIK`,
`1212187 CIRURGIA PTERÍGIO`.

### ⛔ O problema que isso revela: os cinco perfis não cabem

Hoje o `iclinic_marcar.py` distingue cinco perfis pelo **procedimento**:

| perfil | procedimento no iClinic |
|---|---|
| `particular` | CONSULTA PARTICULAR |
| `particular-cirurgia` | CONSULTA PARTICULAR CIRURGIA |
| `particular-desconto` | CONSULTA PARTICULAR COM DESCONTO |
| `unimed` | CONSULTA UNIMED |
| `unimed-cirurgia` | CONSULTA UNIMED CIRURGIA |

Na CNN existe **uma** consulta: `CONSULTA OFTALMOLÓGICA`. A distinção tem de
migrar para o convênio — e aí ela **não fecha**:

| perfil | convênio CNN | procedimento CNN | fecha? |
|---|---|---|---|
| `particular` | 74466 PARTICULAR | 1212102 | ✅ |
| `particular-desconto` | 74543 PARTICULAR DESCONTO | 1212102 | ✅ |
| `unimed` | 74544 UNIMED | 1212102 | ✅ |
| `particular-cirurgia` | 74466 PARTICULAR | 1212102 | ❌ **igual a `particular`** |
| `unimed-cirurgia` | 74544 UNIMED | 1212102 | ❌ **igual a `unimed`** |

**É decisão da clínica**, não nossa: o perfil determina o que é cobrado, e hoje
"consulta de avaliação para cirurgia" é uma linha distinta no faturamento. Ou
se criam dois procedimentos novos na CNN, ou os dois pares colapsam e a clínica
perde a distinção. Enquanto não houver resposta, **`*-cirurgia` não pode ser
marcado automaticamente** — melhor escalar que cobrar errado.

⚠️ Note também que o iClinic tem `plamta` (701362) e a CNN tem `IASPI`. São o
mesmo convênio com nomes diferentes nos dois sistemas — e PLAMTA/PLANTE já
causaram o erro de 23/10.

## Status: a tabela de equivalência

A CNN tem 12 status, com nomes legíveis (o iClinic tinha códigos de 2 letras):

`AGENDADO, CONFIRMADO, CONFIRMADO_PACIENTE, CANCELADO, CANCELADO_PACIENTE,
EM_ESPERA, EM_ANDAMENTO, FINALIZADO, FALTOU, PAGAMENTO, PRE_ATENDIMENTO,
REMARCOU`

Proposta de tradução — **a ser conferida pela clínica**, porque ela decide
ocupação e ocupação decide o que é oferecido ao paciente:

| nosso conceito | iClinic | CNN (proposta) |
|---|---|---|
| horário LIVRE | `ca`, `fl`, `na` | `CANCELADO`, `CANCELADO_PACIENTE`, `FALTOU`, `REMARCOU` |
| ocupado | demais | `AGENDADO`, `CONFIRMADO`, `CONFIRMADO_PACIENTE`, `EM_ESPERA`, `EM_ANDAMENTO`, `PRE_ATENDIMENTO`, `PAGAMENTO` |
| compareceu | `cp` | `FINALIZADO` |
| criar como | `sc` | `AGENDADO` |
| bloqueado | `bl`, `hd` | **sem equivalente** — ver abaixo |

⛔ **`bl` (bloqueado) e `hd` não têm status correspondente.** Na CNN o bloqueio
de horário provavelmente vive em `/executor-agenda/disponibilidade`, que é outro
conceito. **Isto precisa ser verificado antes da virada**: se a clínica bloqueia
a agenda por outro mecanismo e nós não o lermos, a Lara oferece horário
bloqueado.

## As três lacunas, e o que fazer com cada uma

### 1. Busca de paciente por telefone (capacidade 3)

`GET /paciente/lista` filtra por `cpfCnpj`, `nomeContem`, `numeroIdentificacao`,
`somenteAtivos` e data — **não por telefone**. E é por telefone que a Lara
reconhece quem escreve no WhatsApp.

O que existe: `GET /agenda/lista` devolve `telefoneCelularPaciente` em cada
evento, e `GET /paciente/{id}` traz `contato`.

Saída: **índice local de telefone → idPaciente**, alimentado por uma varredura
paginada de `/paciente/lista` e atualizado pelos eventos da agenda. É trabalho
novo que não existia, e é o item que mais atrasa a virada.

### 2. Financeiro para a NF-e (capacidade 5)

O `nfse_coletar.py` lê hoje `GET /financas/busca/` do iClinic — o que foi
cobrado no dia. Na CNN só há `GET /orcamento/lista` (orçamentos, com status
`ABERTO/APROVADO/PERDIDO/CANCELADO`), que é outra coisa.

⛔ **Se a clínica não lançar a cobrança como orçamento aprovado, o pipeline de
NFS-e para na segunda-feira.** Perguntar ao suporte da CNN se há endpoint
financeiro fora do Swagger público; se não houver, a emissão volta a ser manual
até existir.

### 3. Prontuário / laudo de topografia (capacidade 6)

Não há endpoint de prontuário. O `iclinic_laudo_topografia.py` já era DOM
(`keyboard.type`), então na CNN ele teria de ser reescrito contra outra tela —
trabalho novo, e é o único motivo que sobraria para manter o Chromium.

**Recomendação: deixar manual na virada.** É o pipeline menos frequente e o
único sem paciente esperando resposta.

## Outro achado: a CNN manda WhatsApp sozinha

`POST /agenda/novo` aceita `notificarWhatsappPaciente`, `notificarSMSPaciente` e
`notificarEmailPaciente`. Se a clínica ligar isso, **o paciente recebe o
lembrete da CNN e o nosso** — duas mensagens para a mesma consulta, e a nossa
supressão de resposta a pipeline não reconhece a deles.

Decidir quem lembra: nós ou a CNN. Se for a CNN, o `send_reminder` sai do ar e a
`JANELA_DO_PIPELINE` perde uma entrada.

## Campos de `POST /agenda/novo` (o que substitui o `criar-evento`)

```
data, horaInicio, horaFim, idPessoaExecutor (163882), idPaciente,
idPacienteConvenio, idTipoConsulta, procedimentos[{idTipoProcedimento,
quantidade, idEspecialidade, idPromocao}], status, telefoneCelularPaciente,
emailPaciente, observacoes, idLocalAgenda, idOrigemPaciente, idRotulo,
notificarWhatsappPaciente/SMS/Email, salaEspera, encaminhamento
```

⚠️ `idPacienteConvenio` **não** é o `idTipoConvenio`: é a associação
paciente↔convênio (`/convenio-paciente/associar`, `/convenio-paciente/lista`).
Para paciente novo em convênio, pode ser preciso associar antes de agendar —
dois passos onde o iClinic tinha um.

## Veredito para a virada de segunda

Capacidades **1, 2 e 4 estão prontas** e são melhores que o que temos hoje.

Três coisas **não** estão, e nenhuma delas se resolve escrevendo código mais
rápido:

1. telefone → paciente exige índice local (trabalho novo);
2. o financeiro da NF-e pode não existir (pergunta ao fornecedor);
3. `*-cirurgia` não tem como ser cobrado certo (decisão da clínica);
4. o bloqueio de agenda não tem equivalente conhecido (verificar, ou a Lara
   oferece horário bloqueado).

Ver `CLINICA-NAS-NUVENS-MIGRACAO.md` para o plano e a ordem.

---

# Descobertas de 24/10 (as três que estavam em aberto)

## (3) O eixo que faltava é `idTipoConsulta` — e a clínica já criou

Os cinco perfis não colapsam. A distinção não está no procedimento (só há
`CONSULTA OFTALMOLÓGICA`), está em **`idTipoConsulta`**, que é um campo próprio
do `POST /agenda/novo`:

| id | tipo de consulta |
|---|---|
| 126577 | CONSULTA |
| 126583 | RETORNO |
| 126581 | EXAME |
| 126591 | **AVALIAÇÃO CIRÚRGICA – CATARATA** |
| 126592 | **AVALIAÇÃO CIRÚRGICA – REFRATIVA** |
| 126593 | **AVALIAÇÃO CIRÚRGICA – PTERÍGIO** |
| 126594 | RETORNO PÓS-OPERATÓRIO |
| 126595 | EXAME EXTERNO |
| 126596 | SOLICITAÇÃO |
| 126579 | Encaixe |

O perfil passa a ser **convênio × tipo de consulta**:

| perfil nosso | idTipoConvenio | idTipoConsulta |
|---|---|---|
| `particular` | 74466 PARTICULAR | 126577 CONSULTA |
| `particular-desconto` | 74543 PARTICULAR DESCONTO | 126577 CONSULTA |
| `unimed` | 74544 UNIMED | 126577 CONSULTA |
| `particular-cirurgia` | 74466 PARTICULAR | **126591/2/3 — qual?** |
| `unimed-cirurgia` | 74544 UNIMED | **126591/2/3 — qual?** |

⛔ **Pergunta nova, criada pela solução.** A CNN é mais específica que nós: ela
quer saber *qual* cirurgia. Nosso perfil `*-cirurgia` é genérico. Ou a triagem
da Lara passa a distinguir catarata / refrativa / pterígio antes de marcar, ou
`*-cirurgia` escala para a secretária escolher. Marcar com o tipo errado é
registrar a avaliação errada na agenda da médica.

Os rótulos (`/agenda-rotulo/lista`) são um terceiro eixo, já usado pela clínica:
`INDICAÇÃO – CATARATA`, `INDICAÇÃO – REFRATIVA`, `INDICAÇÃO – PTERÍGIO`,
`SEM INDICAÇÃO`, mais 16 cores. Não é obrigatório para marcar.

## (4) O bloqueio é `/executor-agenda/disponibilidade`

Não é um status: é um endpoint. Ele devolve a grade de horários **livres**, de
20 em 20 minutos, já respeitando a configuração da agenda da clínica.

Medido em 21/10/2026 para o executor 163882:

```
08:00 08:20 08:40 09:00 09:20 09:40 10:00 10:20 10:40 11:00 11:20 11:40
14:00 14:20 14:40 15:00 15:20 15:40 16:00 16:20 16:40 17:00 17:20 17:40
```

→ **12:00–14:00 não aparece.** O almoço já vem subtraído. Ou seja, a grade
carrega a configuração de bloqueio da clínica, e isso substitui o `bl`/`hd` do
iClinic com vantagem: em vez de inferirmos ocupação a partir de status, a
própria CNN diz o que pode ser oferecido.

⚠️ **O que este teste NÃO provou**: se a grade também subtrai consulta já
marcada. O único evento existente no período (21/10, 13:32–13:52) cai dentro do
intervalo de almoço, que já estava fora da grade — então o teste foi
inconclusivo. **Precisa de uma marcação de teste em horário da grade**, criada e
cancelada, para responder. É a pergunta mais importante que resta: se a
disponibilidade não subtrair o marcado, usá-la sozinha oferece horário ocupado.

## (1) Telefone → paciente: a base ainda não foi importada

`GET /paciente/lista?registrosPorPagina=1` devolve `totalPaginas = 5` (4
ativos). **A base de pacientes da clínica não está na CNN.**

Isso muda a natureza do problema. O índice local de telefone é trivial hoje —
são 5 registros —, mas:

⛔ **Se a base não for importada antes de segunda, a Lara não reconhece ninguém.**
Todo paciente que escrever será novo para a CNN, a conferência de identidade
(nome + nascimento) não vai achar cadastro, e o fluxo que hoje reaproveita o
paciente existente vai criar cadastro novo para quem já é da casa — ou escalar
tudo.

A importação da base é **pré-requisito da virada**, e não é trabalho nosso.

## Confirmado em 24/10

- **NF-e**: a cobrança passa a ser lançada como **orçamento aprovado**, então
  `GET /orcamento/lista?status=APROVADO&tipoData=…` é a fonte do `nfse_coletar`.
- **`notificarWhatsappPaciente` fica DESLIGADO.** Quem lembra o paciente
  continua sendo o nosso `send_reminder`.
- O expediente da Lara (07:30–18:30) é diferente do horário da clínica
  (08:00–18:00) **de propósito**. Não é divergência.
