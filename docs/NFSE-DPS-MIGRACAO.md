# Migração NFS-e: ABRASF 2.03 → DPS / Padrão Nacional (Teresina)

Status: **plano**, nada implementado. Levantado em 2026-10-02 a partir da
[página da SEMF](https://cartadeservicos-semf.pmt.pi.gov.br/dps) (atualizada em
20/08/2026) e dos documentos oficiais, todos lidos por inteiro: *Guia de
Utilização da API THE V7* (DSF), *Guia do Emissor Municipal Web V1*, Anexo I
(ADN/DPS/NFS-e v1.01), esquemas XSD v1.01 e o XML modelo de DPS.

## O que muda, em uma linha

O **transporte e o leiaute** mudam; o **certificado, o motor de assinatura e
todo o resto do pipeline** continuam valendo (com uma exceção: o assinador de
*lote* é descartado — ver abaixo).

| | Hoje (implementado) | Novo (DPS) |
|---|---|---|
| Protocolo | SOAP ABRASF 2.03 | REST/JSON |
| Endpoint prod | `notafiscal.teresina.pi.gov.br/notafiscal-abrasfv203-ws/NotaFiscalSoap` | `https://nfseapi.teresina.pi.gov.br/notafiscal-ws/nfse` |
| Endpoint homolog | nunca foi plugado (`TODO(homolog)`, env vazia) | `https://nfse2-the.dsfweb.com.br/notafiscal-ws/nfse` |
| Documento | RPS em lote → NFS-e | **DPS** (Declaração de Prestação de Serviço) → NFS-e |
| Corpo | envelope SOAP com XML assinado | `{"dpsXmlGZipB64": "<base64(gzip(XML DPS assinado))>"}` |
| Resposta | XML SOAP | JSON: `tipoAmbiente`, `versaoAplicativo`, `dataHoraProcessamento`, `idDps`, **`chaveAcesso`**, `nfseXmlGZipB64`, `alertas[]` |
| Identificador | número + código de verificação | **chave de acesso (50 posições)** |
| Cancelamento | operação SOAP | `POST /notafiscal-ws/nfse/{chaveAcesso}/eventos` |
| Consulta | operação SOAP | `GET /notafiscal-ws/nfse/{chaveAcesso}` |
| Autenticação | certificado A1 na assinatura do XML | **mesmo A1**, agora também como certificado de cliente (CNPJ raiz do cert = CNPJ do contribuinte na DPS) |
| Tributos | só ISS | ISS **+ IBS/CBS**: CST, `cClassTrib`, regime de apuração, valores individualizados |

Todas as chamadas são **síncronas** (201 = NFS-e criada; 500 = falha no
processamento da DPS).

## A API completa (guia DSF V7, lido por inteiro)

Base: homologação `https://nfse2-the.dsfweb.com.br`, produção `https://nfseapi.teresina.pi.gov.br`.

| # | Método | Caminho | Corpo | Retorno |
|---|---|---|---|---|
| 1 | POST | `/notafiscal-ws/nfse` | `{dpsXmlGZipB64}` | 201: `tipoAmbiente`, `versaoAplicativo`, `dataHoraProcessamento`, `idDps`, `chaveAcesso`, `nfseXmlGZipB64`, `alertas[]` |
| 2 | POST | `/notafiscal-ws/nfse/{chaveAcesso}/eventos` | `{pedidoRegistroEventoXmlGZipB64}` | 201: `eventoXmlGZipB64`. 400 = viola regra de negócio; 401 = sem permissão |
| 3 | GET | `/notafiscal-ws/nfse/{chaveAcesso}` | — | 200: `nfseXmlGZipB64`. 400 = chave ≠ 50 dígitos; **401 = "não foi possível obter o certificado de cliente"**; 403; 404 |
| 4 | GET | `/notafiscal-ws/nfse/dps/{id}` | — | 200: `idDps` + `chaveAcesso`. 404 = nenhuma NFS-e gerada para essa DPS |

O **401 do GET** ("não foi possível obter o certificado de cliente") confirma
mTLS de forma inequívoca.

### O endpoint nº 4 é o que salva de nota duplicada

`GET /nfse/dps/{id}` devolve a chave de acesso a partir do **identificador da
DPS**. Isso resolve o pior cenário operacional: o POST sai, a prefeitura gera a
nota, e a resposta se perde (timeout, queda de rede). Sem esse endpoint, a
única saída seria reenviar e arriscar nota duplicada — com efeito fiscal real.
Com ele, o retry correto é: **perguntar se já existe NFS-e para aquele `idDps`
antes de reenviar**. Isso tem que estar no código desde a primeira versão, não
depois do primeiro susto.

### Padrão de assinatura (seção 4 do guia)

- `infDPS` tem atributo `Id` (ex.: `Id="DPS00001..."`); o `<Reference URI="#DPS00001...">`
  aponta para ele.
- `<Signature>` dentro da raiz `DPS`, irmão de `infDPS` (**enveloped**).
- **Sem prefixo**: `<Signature xmlns="http://www.w3.org/2000/09/xmldsig#">`,
  nunca `<ds:Signature>` — coerente com a E1228.
- Transforms obrigatórias: `enveloped-signature` + `REC-xml-c14n-20010315` (C14N inclusiva).
- CanonicalizationMethod: C14N inclusiva.
- SignatureMethod: **rsa-sha1**. DigestMethod: **sha1**. (Não é SHA-256 — assumir
  errado aqui falha de um jeito difícil de diagnosticar.)

### ✅ Assinatura encaixada e verificada (Fase 2b, 2026-10-02)

`nfse_dps.py --assinar` assina e confere. Testado **dentro do container da VM**
(o único ambiente com `xmlsec`; a imagem local está defasada e não tem nem
`lxml` nem `xmlsec`), com certificado autoassinado descartável — o A1 real não
foi usado e nada foi transmitido.

Conferido item a item contra a seção 4 do guia:

| Exigência | Resultado |
|---|---|
| `<Signature xmlns="…xmldsig#">` **sem prefixo** | ✅ (sem `ds:`) |
| `<Signature>` irmã de `infDPS`, dentro de `DPS` | ✅ |
| `Reference URI="#<Id do infDPS>"` | ✅ `#DPS2211001…` |
| Transforms `enveloped-signature` + C14N | ✅ as duas |
| CanonicalizationMethod C14N inclusiva | ✅ `REC-xml-c14n-20010315` |
| SignatureMethod | ✅ `rsa-sha1` |
| DigestMethod | ✅ `sha1` |
| KeyInfo com SubjectName + IssuerSerial + Certificate | ✅ |
| DPS assinada ainda valida no XSD | ✅ |
| **Assinatura prende o conteúdo** | ✅ alterar `vServ` depois de assinar invalida |

O `KeyInfo` completo foi herdado de propósito do `nfse_emitir.py`: o validador
Java do DSF estoura NPE ("obj must not be null") quando o KeyInfo traz só o
`X509Certificate`, porque desreferencia SubjectName/IssuerSerial (descoberto em
produção em 2026-07-15). O endpoint de DPS é do **mesmo fornecedor**, então
mantivemos.

✅ **Boa notícia: metade do assinador já está pronta.** A função `sign()` do
`nfse_emitir.py` (assina `InfDeclaracaoPrestacaoServico` com `Reference #inf_id`)
já usa `TransformInclC14N` + `TransformRsaSha1` + `TransformEnveloped` — é
exatamente a forma que a DPS pede. **Só o assinador de lote `_sign_lote()` não
serve** (usa prefixo `ns2` e `URI=""`, que violam a E1228 e o padrão acima);
esse a gente descarta.

## O que já temos e não precisa refazer

- Certificado A1 e-CNPJ (`NFSE_CERT_PATH` / `NFSE_CERT_PASSWORD`) — o guia exige
  cert cujo CNPJ raiz bata com o contribuinte da DPS. É o mesmo que já usamos.
- Assinatura XML-DSig via `xmlsec`, já instalada no container.
- `nfse_coletar.py` — coleta dos atendimentos particulares no iClinic. **Não muda.**
- Aprovação no WhatsApp, `nfse_ignorar.py`, entrega do PDF ao paciente. **Não muda.**
- **Credenciamento não é necessário**: basta a empresa estar apta a emitir NFS-e
  em Teresina, o que já é o caso.

## 🚨 O que falta para emitir em produção (levantado 05/10/2026)

**A migração deixou de ser opcional.** Em 05/10/2026 a emissão pelo caminho
antigo foi recusada em produção (protocolo 020491055, paciente Anna Claudya):

> `L999` — "O Emissor atual está disponível somente para contribuintes
> enquadrados no Simples Nacional ou que possuam atividade vigente vinculada aos
> itens de serviço 01.03, 01.05, 01.09 ou 16.01. Para realizar a emissão,
> utilize o Novo emissor ajustado ao padrão nacional."

A CARDIOMED não é optante do Simples (`opSimpNac: "1"`) e seus itens são
04.01/04.03. O `nfse_emitir.py` (ABRASF 2.03) **morreu** para esta inscrição.
(Esse L999 não tem relação com o L999 de CEP faltando: a DSF usa L999 como código
genérico e só a mensagem é diagnóstica.)

### Pronto e verificado

Fases 1 a 4 feitas: conexão, montagem + XSD, emissão em homologação,
cancelamento. Assinatura conferida contra os 8 requisitos do guia; trava
anti-duplicata provada (reenvio devolveu `reaproveitada: true`). O certificado A1
está na VM (`NFSE_CERT_B64` + `NFSE_CERT_PASSWORD`), `NFSE_AMBIENTE=producao`, e a
imagem do container tem `xmlsec`, `lxml`, `playwright` e `requests-pkcs12`.

### 1. Bloqueia a emissão — técnico, nosso

| O que | Estado |
|---|---|
| `NFSE_MODO=dps` | ✅ **ligado em produção** 05/10/2026 22:10 (backup em `.env.bak-20261005-221051`) |
| `NFSE_MODO` em `FORWARDED_ENV_VARS` | ✅ feito (commit `7f5be1a7`), conferido no `dist` da VM |
| Assinatura dentro do container | ✅ **provada** 05/10/2026 — ver abaixo |
| `nfse_dps_state.json` | ausente — a sequência de `nDPS` começa em 1 (aceito) |

⚠️ **A chave está ligada: a próxima aprovação no WhatsApp emite por DPS, de
verdade.** Ligar a chave sozinha não emite nada — a emissão só acontece quando
alguem aprova itens no grupo.

⚠️ **Setar `NFSE_MODO=dps` no `.env` não é suficiente.** A emissão roda *dentro*
do container, e a lista encaminhada (`container-runner.ts:97-102`) tem
`NFSE_CERT_B64`, `NFSE_CERT_PASSWORD`, `NFSE_RPS_INICIAL`, `NFSE_INICIO`,
`NFSE_PROXY` e `NFSE_AMBIENTE`. Sem mudança de código + deploy, o pipeline dentro
do container continua lendo `abrasf` e falhando no L999.

**O mínimo a encaminhar é `NFSE_MODO`** — e só ele. Levantadas invertendo a
busca (todo `environ.get("NFSE...")` dos três scripts do DPS × a lista
encaminhada), as outras não encaminhadas têm default seguro em código e **não
precisam entrar**:

| Var | Default | Por que não precisa |
|---|---|---|
| `NFSE_DPS_SERIE` | `10001` | já é a faixa do contribuinte exigida pelo L0022 |
| `NFSE_XSD_DIR` | vazio | só o CLI valida contra XSD; a emissão pula |
| `NFSE_CERT_PATH` | vazio | a pipeline usa `NFSE_CERT_B64`, não o caminho |
| `NFSE_CNPJ` / `NFSE_IM` | valores reais da CARDIOMED | já corretos |
| `NFSE_DPS_TIMEOUT` | `180` | suficiente (1ª emissão em homolog estourou 60s) |
| `NFSE_DPS_SEP_DESC` | `" - "` | cosmético |
| `NFSE_CST_PISCOFINS` | `01` | só caminho PJ, que está travado |

`NFSE_DPS_INICIAL` só é necessária para **não** começar do 1.

✅ **Assinatura exercitada dentro do container (05/10/2026).** Até então o
caminho DPS nunca havia rodado em container — nenhum transcript de sessão nem log
mencionava `nfse_dps` —, ou seja a primeira execução em container seria também a
primeira emissão em produção ("a imagem tem `xmlsec` instalado" não é o mesmo que
"assinar funciona na imagem").

Teste feito com `nfse_dps.py --assinar`, que monta uma DPS com tomador fictício,
assina com o A1 e verifica — rodando com `--network none`, logo **sem
possibilidade de emitir**. Resultado: `✅ assinatura: assinatura confere`, exit 0.
O `xmlsec` da imagem funciona com o certificado real.

Como repetir: materializar o `.pfx` do `NFSE_CERT_B64` num temporário dentro do
container e chamar `--assinar --pfx <temp>`. Credenciais por `-e NOME` (herdando
o valor), nunca `-e NOME=valor`, que deixaria a senha visível em `ps`.

Sobre a sequência de `nDPS`: é **separada** da numeração de RPS do ABRASF, e o
`nfse_emitir_pipeline.py:216` a avança **uma vez por lote, depois** do loop de
emissão — logo um crash no meio do lote perde o avanço e o próximo run reusa o
`nDPS`. Na prática o `emitir_com_protecao` consulta por `idDps` antes de enviar,
o que cobre isso. Se começar do 1 colide com o que foi gasto em homologação
**é hipótese não testada** — não sabemos se a prefeitura compartilha a série
entre ambientes.

### 2. Limita o alcance — decisão, não bug

- **Tomador PJ não sai por DPS** (`nfse_dps.py:197`, `raise ValueError`): o
  `tpRetPisCofins`/`CST_PISCOFINS` são novos no padrão nacional e numa emissão de
  teste a prefeitura calculou o líquido ignorando PIS/COFINS, divergindo de uma
  nota real validada pelo contador. Nota para CNPJ fica **manual**. Depende do
  contador, não de código.
- **Cirurgia nunca foi testada de ponta a ponta**: `cTribMun` `003` é recusado em
  homologação com L0001 (cadastro econômico daquele ambiente desatualizado). A
  primeira cirurgia real em produção é o teste. Falha isolada: o item cai sozinho
  e reaparece no dia seguinte.

### 3. Quebra a entrega do PDF — não a emissão

A DPS devolve `chaveAcesso` e `nNFSe`, nunca código de verificação, e o endpoint
do DANFSE exige o código (ver Fase 5). O contorno existe
(`nfse_danfse_portal.py`), mas falta:

| O que | Estado |
|---|---|
| `NFSE_DANFSE_PORTAL=1` | ausente (o contorno vem desligado) |
| `NFSE_PORTAL_USUARIO` | **ausente** no `.env` (a senha está) |
| `NFSE_PORTAL_*` / `NFSE_DANFSE_PORTAL` encaminhadas | **nenhuma** está |

Risco a medir antes de ligar: o Chromium sobe dentro da emissão e o pré-check do
agent-runner corta em 180s — já foi problema com o coletor, que leva ~87s.

✅ Isso **não** impede faturar: a nota sai, o PDF entra como pendente no resumo
do WhatsApp.

### 4. Confirmações menores do contador

`regEspTrib: "0"` (`nfse_dps.py:42`) nunca foi confirmado. `CST_PISCOFINS` e
`RETENCOES_PJ` também não, mas só afetam o caminho PJ, que já está travado.

### Ordem sugerida

1. ~~Encaminhar `NFSE_MODO` + deploy~~ — ✅ feito (`7f5be1a7`).
2. ~~Exercitar a assinatura dentro do container~~ — ✅ feito, assinatura confere.
3. ~~Decidir o `nDPS` inicial~~ — aceito começar do 1.
4. ✅ `NFSE_MODO=dps` ligado. **Falta a primeira emissão:** uma nota PF de
   **consulta** — categoria com NBS conferido contra nota real — de menor valor.

   ⚠️ **Não há candidato de consulta hoje.** O `pending_nfse.json` tem um único
   item emissível: Anna Claudya, R$ 5.900, **cirurgia** — justamente a categoria
   com `cTribMun 003` nunca testado. Seguir esta ordem ao pé da letra com a lista
   atual faria a categoria mais arriscada ser a primeira DPS de produção, no
   maior valor. Esperar uma consulta entrar na lista, ou aceitar o risco
   conscientemente.
5. Conferir a nota no portal antes de liberar o lote.
6. Depois: DANFSE (encaminhar `NFSE_PORTAL_USUARIO`/`NFSE_PORTAL_SENHA` e
   `NFSE_DANFSE_PORTAL`, medir o tempo do Chromium) e PJ (com o contador).

## Fases

Cada fase é verificável sozinha. Nenhuma toca produção até a Fase 6.

### ⛔ Escopo: a emissão por DPS NÃO atende tomador PJ (decidido 2026-10-02)

Nota para **CNPJ é emitida à mão**. A automação recusa, em dois níveis:
`monta_dps()` levanta erro, e o pipeline separa o item antes de montar.

**Por quê.** O padrão nacional exige classificar as retenções federais — `CST`
do PIS/COFINS e `tpRetPisCofins` — campos que o ABRASF não tinha. Cheguei a
implementar: numa emissão de teste para CNPJ a prefeitura aceitou e devolveu
vPis 6,50 / vCofins 30,00 / vRetIRRF 15,00 / vRetCSLL 10,00 sobre R$ 1.000.
Mas o **líquido veio 975,00**, ou seja, ela ignorou PIS e COFINS no cálculo —
enquanto numa NFS-e **real de produção** (nº 3.452, validada pelo contador) o
líquido desconta as quatro retenções. Algo na classificação que envio diverge,
provavelmente o `CST`, que foi escolha minha entre 34 opções do enum e **não
aparece impresso no DANFSe** para conferir.

Emitir com classificação fiscal errada tem efeito real. Preferimos recusar.

O item PJ **não é marcado como emitido** (reaparece no dia seguinte) e sai numa
seção própria do resumo — não entra em "Falharam", porque não é falha e listar
duas vezes confunde a recepção:

```
🧾 *Emitir À MÃO* (tomador CNPJ — a automação não atende):
• HOSPITAL DE OLHOS LTDA (topografia) — R$ 1500.00
_Continuam na lista até serem emitidas._
```

Para retomar: o código das retenções está no commit `107f95cd`, e o que falta é
o `CST` real — visível no XML de uma nota de produção para PJ.

### Fase 0 — Destravar as decisões que não são técnicas
Bloqueiam o resto; começar por aqui.
1. **Contador** — ✅ **respondido em 2026-10-02** (conferido na tela do próprio
   emissor municipal):
   - `CST` = **200** (Alíquota reduzida);
   - `cClassTrib` = **200029** (Fornecimento dos serviços de saúde humana, Anexo III);
   - `cNBS` **varia por categoria** — não há um código único para a clínica. Os
     valores em vigor estão na seção "Os códigos que valem para a CARDIOMED";
     não repetidos aqui de propósito, porque foi a cópia que deixou este doc
     divergir do código (o XSD exige 9 dígitos sem pontos).

   Aplicados no `nfse_dps.py` (`CODIGOS_POR_CATEGORIA`); as 5 variações de
   serviço da clínica validam.

   **Nada mais precisa ser enviado pela redução de alíquota:** a regra confirma
   que `pRedutor` só vale para compra governamental (E1522/E1523, exige
   `tpEnteGov`) e que `pAliqEfetUF/Mun/CBS` ficam na **NFS-e de resposta**,
   calculados pelo autorizador a partir do `cClassTrib`. A DPS fecha com
   CST + cClassTrib.

   **Resolvidos depois** (estavam listados aqui como pendentes): `cIndOp` é
   `030101`, não o `100301` copiado do XML modelo — o `100301` é recusado para
   saúde com L0008. `cTribNac` e `cTribMun` também fecharam, e variam por
   categoria: ver a tabela adiante.
2. **SEMF** (notafiscaleletronica.semf@pmt.pi.gov.br): (a) até quando o ABRASF
   2.03 continua aceito? A página fala em coexistência na transição, mas não dá
   data de desligamento. (b) reportar o defeito do `TSSerieDPS` no XSD v1.01
   (ver Fase 2).
3. **DANFSE — continua em aberto, mas delimitado.** Hoje o PDF vem do portal
   por número + código de verificação (`baixar_danfse`). Li o *Guia do Emissor
   Municipal Web* inteiro: ele cobre só a emissão **manual** e não documenta
   download de PDF por API. O que se sabe:
   - a API devolve **`chaveAcesso` + XML da NFS-e**, e o leiaute `NFSe/infNFSe`
     identifica a nota por `id`/`nNFSe`/`chave` — **não** por código de verificação;
   - o portal municipal **continua exibindo** "código de verificação" após a
     emissão web, ou seja, o conceito não morreu no sistema do DSF;
   - existe `cVerifNFSeMun` no XSD, **mas dentro de `TCDocOutNFSe`**, que é
     referência a *outra* nota municipal — **não** é o identificador da nota
     retornada. Não dá para contar com ele.

   Conclusão: não dá para afirmar que o `baixar_danfse` atual sobrevive. Resolver
   empiricamente na Fase 5 (emitir em homologação e procurar a nota no portal) ou
   perguntar à SEMF se há DANFSE por chave de acesso. **Plano B barato:** manter
   o PDF atual enquanto durar a coexistência; se não houver caminho, gerar o
   DANFSE a partir do próprio XML da NFS-e, que já trazemos na resposta.
4. **Acesso ao portal de homologação** (<https://nfse2-the.dsfweb.com.br/notafiscal/>),
   para conferir visualmente as notas de teste. Três caminhos de login:
   CPF/CNPJ + senha; **certificado digital** (exige Java + drivers instalados —
   não serve para automação); ou GOV.BR / senha do portal de finanças. O
   credenciamento do **portal** é separado da API: para transmitir DPS não há
   credenciamento prévio, mas para *ver* as notas no portal de homologação
   precisamos de acesso. Isso é tarefa humana — eu não faço login em site
   externo.

### Fase 1 — Conexão em homologação (sem regra de negócio)
Provar que o certificado é aceito pelo endpoint novo.
- Env: `NFSE_DPS_URL_HOMOLOGACAO=https://nfse2-the.dsfweb.com.br`,
  `NFSE_DPS_URL_PRODUCAO=https://nfseapi.teresina.pi.gov.br`.
- mTLS com o A1 (converter o `.pfx` para cert+key em memória; não gravar em disco).
- Critério de pronto: um **POST** que seja recusado por regra de **conteúdo**
  (E12xx de leiaute), não por certificado (E1200–E1209). Ver a sondagem abaixo
  para entender por que o critério não pode ser um GET.

#### Sondagem já feita (2026-10-02) — os dois ambientes estão no ar

`GET /notafiscal-ws/nfse/{50 zeros}`, **sem certificado de cliente**:

| Ambiente | Resposta |
|---|---|
| `nfse2-the.dsfweb.com.br` | HTTP 400 em 0,36s — `"tipoAmbiente":"2"` (homologação) |
| `nfseapi.teresina.pi.gov.br` | HTTP 400 em 0,23s — `"tipoAmbiente":"1"` (produção) |

Envelope de erro (serve para o parser desde já):

```json
{"tipoAmbiente":"1","versaoAplicativo":"1.01",
 "dataHoraProcessamento":"2026-10-02T07:33:14.734866817-03:00",
 "erros":[{"codigo":"E0044","mensagem":"NFS-e não existe na base de dados do autorizador ..."}]}
```

⚠️ **Correção importante do plano:** o GET de consulta **responde sem nenhum
certificado de cliente**. O guia lista 401 ("não foi possível obter o
certificado de cliente") como resposta possível, mas na prática a consulta não
exige mTLS. Logo, **um GET bem-sucedido NÃO prova que nosso certificado é
aceito** — só a transmissão (POST) exerce as regras E1200–E1209. O critério de
pronto da Fase 1 foi corrigido acima por causa disso.

Outras descobertas da sondagem:
- caminho correto é `/notafiscal-ws/...` na raiz do host (sob `/notafiscal/` dá 404);
- `/notafiscal-ws/nfse` sem chave → 405, coerente com "POST apenas";
- `versaoAplicativo` 1.01 nos dois ambientes;
- a primeira chamada à homologação levou 25s e estourou timeout; a seguinte
  respondeu em 0,36s. **Cold start** — o cliente precisa de timeout generoso e
  retry, senão a primeira emissão do dia falha sozinha.

### Fase 2 — Montar e validar a DPS localmente
Os insumos já estão baixados (`~/Downloads`): XSDs v1.01, Anexo I, XML modelo,
guia da API e guia do emissor web.

- Montar a DPS a partir dos mesmos dados que hoje alimentam o RPS, + campos
  novos da Fase 0.1.
- Validar contra `Schemas/1.01/DPS_v1.01.xsd` **antes** de enviar (lxml),
  assinar com xmlsec.
- Critério de pronto: DPS válida no XSD e assinatura conferida localmente.
  Nenhuma chamada de rede nesta fase.

**✅ FEITO (2026-10-02):** `scripts/nfse_dps.py` monta uma DPS completa com dados
fictícios e ela **valida contra o `DPS_v1.01.xsd`**. Rode:
`python3 nfse_dps.py --xsd <Schemas/1.01>`. Falta só a assinatura (Fase 2b) e os
valores reais de IBS/CBS (Fase 0.1) — a estrutura está fechada.

Testes negativos confirmam que a validação é real, não decorativa: removendo
`CEP`, `CST`, `xNome` ou `cTribNac` o schema rejeita com mensagem apontando o
campo. **O caso do CEP é o mesmo que gerou o "L999 = cpfCnpjTomadorInvalido"
enganoso em produção — agora é pego em casa, antes da requisição.**

🐞 **Defeito no XSD oficial v1.01 (reportar à SEMF).** `TSSerieDPS` tem
`pattern="^0{0,4}\d{1,5}$"`. Em XML Schema o pattern **já é ancorado** e `^`/`$`
são **caracteres literais** — ou seja, o tipo só aceita a string literal
`^00001$`, e **nenhuma série legítima valida** (o próprio XML modelo publicado
pela SEMF falha nesse campo). Varri os demais tipos: é o **único** com esse
defeito. O `nfse_dps.py` corrige o pattern **em memória**, sem tocar no arquivo
baixado (`--xsd-cru` desliga a correção e mostra o bug). Reavaliar se sair v1.02.

**Verificado antes (2026-10-02):** a validação local funciona — rodei o XML modelo
contra o XSD v1.01 com lxml e os únicos erros são os `???????` do próprio
modelo (`tpAmb` fora do enum, `CNPJ` fora do padrão `[0-9]{14}`, etc.). Ou seja:
**erramos campo em casa, com mensagem precisa, em vez de descobrir no retorno
enigmático da prefeitura** — exatamente a classe do "L999 = CEP faltando".

⚠️ **Pegadinha:** o XML modelo publicado **vem sem namespace**. O XSD exige
`xmlns="http://www.sped.fazenda.gov.br/nfse"` na raiz `<DPS>`; sem isso o
validador rejeita com "No matching global declaration available for the
validation root".

⚠️ **Pegadinha maior — namespace com prefixo é REJEITADO.** A regra **E1228**
("Uso de prefixo de namespace não permitido na área de dados descompactada")
proíbe prefixo. Isso é o **oposto** do que o `nfse_emitir.py` faz hoje: o
código atual monta elementos sem namespace e declara `ns2`/`ns3` na raiz
porque *"o DSF/Teresina exige"* no ABRASF. **Essa lógica não pode ser
reaproveitada** — na DPS tem que ser namespace default, sem prefixo. É o tipo
de detalhe que custaria um dia de depuração às cegas.

#### Regras de rejeição na recepção (aba `RN_RECEPCAO_DPS` do Anexo I)

Certificado de transmissão — confirma que é **mTLS com e-CNPJ ICP-Brasil**:

| Cód. | Rejeição |
|---|---|
| E1200 | Certificado de transmissão inválido/ausente |
| E1203 | Certificado expirado |
| E1205 | Erro na cadeia de certificação (AC não cadastrada na RFB) |
| E1206 | Erro de acesso à LCR (falta CRL DistributionPoint ou LCR inacessível) |
| E1207 | Certificado revogado |
| E1208 | Certificado raiz difere da ICP-Brasil |
| E1209 | Falta a extensão de CNPJ/CPF no certificado (OtherName OID 2.16.76.1.3.3) |

Área de dados:

| Cód. | Rejeição |
|---|---|
| E1225 | Falha na decodificação do base64 |
| E1226 | Estrutura descompactada mal formada |
| E1228 | **Prefixo de namespace não permitido** |
| E1229 | XML não está em UTF-8 |
| E1235 | Falha no esquema XML |
| E1242 | Tipo de DF-e não tratado |

O **E1206** merece atenção operacional: a validação consulta a LCR do nosso
certificado pela rede. Se a VM tiver saída bloqueada para o endpoint da LCR da
AC, a nota é rejeitada por um motivo que não tem nada a ver com o conteúdo.

#### Mapa de campos da DPS (extraído do modelo)

```
DPS/infDPS   tpAmb dhEmi verAplic(1.01) serie nDPS dCompet tpEmit cLocEmi
  prest      CNPJ IM regTrib{opSimpNac regEspTrib}
  toma       CNPJ|CPF xNome end/endNac{cMun CEP} xLgr nro xBairro
  serv       locPrest{cLocPrestacao} cServ{cTribNac cTribMun xDescServ cNBS}
  valores    vServPrest{vServ}
             trib/tribMun{tribISSQN tpRetISSQN pAliq}
             trib/tribFed{piscofins{CST vPis vCofins tpRetPisCofins} vRetIRRF vRetCSLL}
             trib/totTrib{indTotTrib}
  IBSCBS     finNFSe cIndOp indDest valores/trib/gIBSCBS{cClassTrib}
```

Note que `toma/end/endNac/CEP` é estrutural aqui — reforça a trava de cadastro
incompleto que já existe na coleta.

**O que exatamente perguntar ao contador** (Fase 0.1), agora com nome de campo:
`cTribNac`, `cTribMun`, `cNBS` (Nomenclatura Brasileira de Serviços — novo, não
existe no ABRASF), `cClassTrib`, `cIndOp`, `regEspTrib`, `opSimpNac` e o `CST`
de PIS/COFINS, para cada categoria de serviço da clínica.

### ✅ Fase 3 FEITA — NFS-e emitida em homologação (2026-10-02)

Primeira nota do padrão nacional gerada com sucesso:

- chave: `NFS22110011263521918000104000000000289626100573252134`
- `nNFSe` 2896, `cStat` 100 (NFS-e Gerada)
- ISS: base 400,00 → **R$ 12,00** (3%)
- IBS/CBS: **redução de 60% aplicada sozinha pelo autorizador**
  (`pRedAliqUF/Mun/CBS = 60.00`, `vIBSTot` 0,15, `vCBS` 1,39) a partir do
  `cClassTrib` 200029 — confirma que não precisamos declarar a redução.

**Cadeia inteira provada:** monta → assina (A1 real) → gzip+base64 → POST mTLS
→ NFS-e. O certificado da clínica **é aceito** (passamos das regras E1200–E1209).
E o reenvio da mesma DPS devolveu `reaproveitada: true` com a mesma chave —
**a trava anti-duplicata funciona de verdade**, não só no papel.

#### Os códigos que valem para a CARDIOMED

Os três primeiros **variam por categoria e andam juntos**: a prefeitura valida o
par NBS ↔ `cTribNac` (L0010) e exige o `cTribMun` vinculado ao cadastro
econômico (L0001). Trocar um sozinho quebra. Fonte: `CODIGOS_POR_CATEGORIA` em
`nfse_dps.py` — divergindo daqui, o código é que vale.

| Categoria | `cTribNac` | `cTribMun` | `cNBS` | Conferido contra |
|---|---|---|---|---|
| consulta | `040101` | `001` | `123012200` (1.2301.22.00) | DANFSe **real** de 02/10/2026 |
| exame | `040301` | `004` | `123012100` (1.2301.21.00) | NFS-e **real** nº 3.452, 29/09/2026, validada pelo contador |
| cirurgia | `040301` | `003` | `123011100` (1.2301.11.00) | **só a palavra do contador** — ver o aviso abaixo |

Os que não variam:

| Campo | Valor | Origem |
|---|---|---|
| `cIndOp` | `030101` | Anexo C: serviço prestado fisicamente sobre a pessoa |
| `CST` | `200` | alíquota reduzida |
| `cClassTrib` | `200029` | saúde humana, Anexo III |
| `serie` | `10001` | faixa do contribuinte (ver L0022) |

**O conflito de NBS foi resolvido — e não como este doc dizia antes.** A versão
anterior adotava 1.2301.19.00 para tudo, vindo de uma tela do portal, com o
argumento de que passava na validação. Passar na validação não quer dizer estar
certo: o 1.2301.19.00 **é** aceito pelo L0010 e **não é** o que a clínica usa.
Quem desempatou foram as notas reais de produção, não o validador.

⚠️ **Cirurgia é a única categoria nunca conferida contra uma nota real.** O par
`040301` + 1.2301.11.00 passa no L0010 (provado em homologação, emitindo com
`cTribMun=004`), mas isso só mostra que o par é aceitável — exatamente o grau de
evidência que já enganou uma vez, no parágrafo acima.

O ponto formalmente em aberto de cirurgia, porém, é o `cTribMun` `003`: em
homologação ele é recusado com L0001 porque o cadastro econômico daquele
ambiente está desatualizado; em produção está correto. Logo **a primeira cirurgia
real é o teste**. Se vier L0001 em produção, o cadastro não foi atualizado — o
item falha sozinho, reaparece no dia seguinte e não afeta as outras categorias.

#### Regras municipais descobertas só emitindo

Nenhuma delas está no XSD nacional nem no Anexo I. Cada uma custou uma tentativa:

| Erro | O que significa |
|---|---|
| **L0022** | série 00001–10000 é exclusiva do sistema municipal; contribuinte usa **10001–49999** |
| **L0010** | o `cNBS` tem que ser compatível com o `cTribNac` (par validado) |
| **L0008** | o `cIndOp` tem que ser compatível com o `cTribNac` — `100301` ("demais serviços") é recusado para saúde |
| **L0001** | o `cTribMun` precisa estar vinculado ao cadastro econômico do prestador |
| **L0017** | `cTribMun` é **obrigatório** em Teresina, embora o XSD nacional o marque `minOccurs=0` |

O `cTribMun` é o **mesmo campo** que o ABRASF chama de
`CodigoTributacaoMunicipio` e que estava vazio com `TODO(contador)` no
`nfse_emitir.py` — o endpoint antigo tolerava; a DPS não.

#### Descrição do serviço: a prefeitura come as quebras de linha

A discriminação é **a mesma de hoje** (importada do `nfse_emitir.py`, não
copiada — uma lista só, sem divergir): identificação da Dra. Marina + CRM/RQE +
o serviço.

⚠️ O escape `\s\n` é convenção do manual ABRASF e **não** pode ir literal para a
DPS. Mas trocar por `\n` real também não serve: embora o XSD aceite
(`TSDesc2000` deriva de `TSStringComQuebraDeLinha`), **o DSF/Teresina descarta
as quebras e cola as palavras** — a nota 2897 voltou com
`...DE SOUSACRM 3816RQE 1949CONSULTA...`. Com `" - "` (`NFSE_DPS_SEP_DESC`) o
texto sobrevive legível, confirmado na nota 2898:

```
SERVIÇOS MÉDICOS PRESTADOS PELA DRA. MARINA COSTA CARVALHO DE SOUSA - CRM 3816 - RQE 1949 - CONSULTA OFTALMOLÓGICA
```

Só um teste de ponta a ponta pega isso: o XSD valida, a API aceita, e o
estrago só aparece relendo a nota gravada.

#### Homologação instável — como distinguir culpa nossa da deles

Em 2026-10-02, à tarde, a homologação degradou: `GET` passou de 0,3s para 33s e
toda emissão voltou `L9999: JDBC exception ... ORA-02049: timeout, transação
distribuída aguardando bloqueio` (lock no Oracle **deles**).

**Teste de controle que separa as coisas:** reemitir com um conjunto de códigos
que **comprovadamente já funcionou**. Reemiti com os códigos da nota 2898
(08:46 do mesmo dia) e deu o mesmo ORA-02049 → ambiente quebrado, não dado
nosso. Sem esse controle, seria fácil culpar a mudança de códigos.

**Como ler os erros:**

| Erro | De quem é |
|---|---|
| `L0001`, `L0008`, `L0010`, `L0017`, `L0022` | **nosso** — regra de negócio sobre os dados |
| `L9999` + `ORA-*` / `JDBC` | **deles** — infraestrutura |
| `ReadTimeout` | indefinido — **consultar `GET /nfse/dps/{id}` antes de reenviar** |

#### Nota de operação: timeout

A 1ª emissão estourou 60s de leitura **sem** gerar nota (confirmado com
`GET /nfse/dps/{id}` → 404). O timeout de emissão subiu para 180s
(`NFSE_DPS_TIMEOUT`). Esse episódio é a prova de que o fluxo correto após
timeout é **consultar, nunca reenviar às cegas**.

### Fase 3 (original) — Emitir em homologação
- `POST /notafiscal-ws/nfse` com `{"dpsXmlGZipB64": ...}` (gzip + base64).
- Descompactar `nfseXmlGZipB64`, guardar `chaveAcesso`, tratar `alertas[]`.
- Exercitar os erros de propósito: CPF inválido, **CEP ausente** (o L999 que já
  nos mordeu — ver memória), valor zerado, CST errado.
- Critério de pronto: nota emitida em homologação e erros com mensagem legível.

### ✅ Fase 4 FEITA — cancelamento funciona (2026-10-02)

`monta_cancelamento()` + `registrar_evento()`. Cancelei a nota de teste 2896 em
homologação com sucesso.

- Evento **e101101** (Cancelamento de NFS-e), dentro de `pedRegEvento/infPedReg`.
- `Id` = **"PRE" + 56 dígitos** = os 50 dígitos da chave + `101101` (o código do
  evento). Não está documentado; deduzido do tamanho e aceito pela prefeitura.
- `CNPJAutor` **XOR** `CPFAutor` (é um `xs:choice`), e o evento também é escolha.
- `xDesc` é enum de valor fixo: `"Cancelamento de NFS-e"`.
- `cMotivo`: 1=Erro na Emissão, 2=Serviço não Prestado, 9=Outros.
- Corpo do POST usa **`pedidoRegistroEventoXmlGZipB64`**, não `dpsXmlGZipB64`.
- O `assina()` foi generalizado (`inner_tag`) para assinar `infPedReg` também.

⚠️ **O `GET /nfse/{chave}` NÃO mostra que a nota foi cancelada.** Depois do
cancelamento a consulta devolve o documento original, com `cStat` 100 e nenhum
vestígio do evento (procurei por "cancel", "evento", "101101": zero
ocorrências). O 201 do POST, sozinho, também não prova nada.

**Como confirmar de verdade:** tentar cancelar de novo. A segunda tentativa
devolve `400 — "Nota fiscal não está ativa. Situação atual Cancelada"`. Foi
assim que validei. Consequência para o pipeline: **não dá para saber pela API
se uma nota está cancelada** — se precisarmos disso, guardar o estado do nosso
lado ao registrar o evento.

Obs.: nesse erro o envelope vem **sem `codigo`** (só `mensagem`), diferente dos
L00xx. O parser precisa tolerar `codigo: None`.

### ⛔ Fase 5 — DANFSE: bloqueada, precisa da SEMF

O endpoint que funciona hoje é público (sem login nem certificado) mas exige
**número + código de verificação**:

```
{portal}/notafiscal-ws/servico/notafiscal/autenticacao/
  cpfCnpj/{cnpj}/inscricaoMunicipal/{im}/numeroNota/{n}/codigoVerificacao/{cod}
```

A emissão por DPS devolve `chaveAcesso` e `nNFSe`, **nunca um código de
verificação** — conferido no XML da NFS-e gerada. Sondei cinco variantes de URL
por chave de acesso em homologação (`.../chaveAcesso/{chave}`,
`.../nfse/{chave}/danfse`, `.../danfse/{chave}`, etc.): **todas 404**.

#### 🔧 Contorno implementado: `nfse_danfse_portal.py` (2026-10-02)

Como a SEMF confirmou que a API não devolve o código, o contorno quebra a
circularidade **uma vez por nota**: o Playwright abre o portal, manda exibir o
DANFSE e **intercepta a requisição** que o portal faz — o código está na URL.

```
navegador (1x por lote)        → código de verificação → nfse_codigos_verificacao.json
nfse_emitir.baixar_danfse(...) → PDF                   → paciente
```

O navegador **não participa do envio ao paciente**: depois de coletado o
código, o download volta a ser o HTTP puro que já roda em produção.

- Uma sessão de navegador por **lote**, não por nota.
- **Desligado por padrão.** Ligue com `NFSE_DANFSE_PORTAL=1` só depois de medir
  o tempo do lote: subir o Chromium dentro da emissão pode estourar o timeout
  de 180s do pré-check do agent-runner — já foi problema com o coletor NFS-e,
  que leva ~87s.
- Falha do portal **nunca** invalida a emissão (as notas já saíram): os PDFs
  entram como pendentes no resumo do WhatsApp.
- Nunca inventa código: nota sem código fica fora do JSON.
- `--debug` salva screenshot e HTML em `tmp/` para reajustar seletores.
- Precisa de `NFSE_PORTAL_USUARIO` / `NFSE_PORTAL_SENHA` no `.env`.

#### ✅ Task separada do DANFSE (2026-10-02)

A emissão **enfileira**; quem baixa é o `nfse_danfse_pipeline.py`, numa task
própria (`marina-danfse`, `0,30 19-21 * * 1-5`).

```
emissão (18:30)   → nota emitida + enfileira o número     → 8 s
marina-danfse     → baixa o PDF → agenda send_nota.py     → ~20 s por nota
```

Medido: a emissão caiu de **87 s para 8 s**. O download continua custando o que
custa, mas agora num lugar onde demorar não derruba nada.

Como a fila se comporta:
- **teto de 6 notas por rodada** (~120 s + login, com margem nos 180 s). O que
  sobra fica para a rodada seguinte, meia hora depois;
- **conta tentativas**: falha transitória do portal se resolve sozinha na
  próxima rodada;
- **desiste após 5 tentativas** e avisa para envio manual — nota CANCELADA, por
  exemplo, nunca terá DANFSE, e insistir para sempre só poluiria o log;
- **sai da fila ao agendar a entrega**, então não reenvia PDF já entregue;
- `wakeAgent` só é `true` quando alguma nota desistiu, ou seja, o agente só é
  acordado quando a recepção precisa agir.

A entrega reusa `entregas/` + `send_nota.py`, o mesmo mecanismo que já roda em
produção no caminho ABRASF — não existem dois jeitos de enviar PDF ao paciente.

#### ⏱️ Medição que levou a isso: NÃO baixar dentro da emissão

Lote de 3 notas com download de PDF: **87 s** (pré-check do agent-runner aborta
em 180 s). Descontando o login, dá ~20 s por nota — então **a partir de ~8 notas
o lote estoura o timeout**, e um dia de movimento passa disso tranquilamente.

**Recomendação: rodar o download como task SEPARADA da emissão**, não dentro
dela. A emissão é rápida e não pode ser derrubada por um navegador lento; o
download pode rodar logo depois, por conta própria, e reprocessar o que faltou.

Enquanto isso não for feito, `NFSE_DANFSE_PORTAL=1` só é seguro para lotes
pequenos.

**Nota cancelada não tem DANFSE** e falha na coleta — comportamento correto,
já que não há PDF para enviar. A mensagem de log diz isso explicitamente em vez
de só "TimeoutError".

#### 🚨 O portal de produção tem DOIS endereços — e um tem captcha

| Host | Login |
|---|---|
| `notafiscal.teresina.pi.gov.br` | **reCAPTCHA** — inautomatizável |
| `the.dsfweb.com.br` | direto, sem captcha — é o host do QR das notas de produção |

Usamos o segundo (`NFSE_PORTAL_PROD`). Login confirmado em produção com a
**mesma senha** da homologação.

⚠️ **Mas isto é tempo emprestado.** A prefeitura está **colocando captcha** —
é exatamente o mecanismo que existe para impedir automação. Se puserem no
`the.dsfweb.com.br` também, a coleta de DANFSE morre de um dia para o outro,
sem aviso. Não é o risco genérico de "layout muda": é alguém trabalhando
ativamente para fechar essa porta.

**Consequência estratégica:** o portal é um paliativo, não a solução. A saída
durável continua sendo a SEMF responder como obter o DANFSE de forma
programática. Vale insistir nessa pergunta mesmo com o contorno funcionando.

#### Certificado digital não resolve o login do portal

Testado em 2026-10-02, três motivos independentes:
- a opção "Certificado Digital" do portal usa **applet Java** no navegador —
  não roda headless;
- nenhum dos dois hosts **solicita certificado de cliente no TLS** (verificado
  com `openssl s_client`: sem "Acceptable client certificate CA names");
- o Playwright do container é anterior ao suporte a `client_certificates`.

O A1 funciona onde já é usado: a **API de DPS** (emissão, cancelamento,
consulta). Para o portal, só senha.

#### Limite conhecido: a listagem vem filtrada por data

O coletor só enxerga as notas da **primeira página da listagem do dia**.
Tentar baixar a nota 3452 (29/09) em produção falhou por isso, não por login.
Para o fluxo real — emitir às 18:30 e baixar entre 19h e 21h do mesmo dia —
é suficiente. Para buscar nota antiga, não serve.

⚠️ **Isto é dívida técnica consciente.** É um contorno por fora de uma
limitação da API deles, e a função `_abrir_nota()` depende do layout do portal.
Se a SEMF expuser o código (ou um endpoint de DANFSE por chave), **apague o
arquivo** — o resto do pipeline não sabe que ele existe.

#### ✅ O DANFSE funciona, falta só obter o código

O QR do DANFSe contém exatamente a URL do endpoint **que o `baixar_danfse` já
usa hoje**:

```
https://the.dsfweb.com.br/notafiscal-ws/servico/notafiscal/autenticacao/
  cpfCnpj/63521918000104/inscricaoMunicipal/0509477/numeroNota/2898/
  codigoVerificacao/gQZUcnVoK
```

Testado: **HTTP 200, `application/pdf`, 368 KB**. Ou seja:

- o **código de verificação EXISTE** para notas de DPS (`gQZUcnVoK`, 9
  alfanuméricos — bate com `TSCodVerificacao` = `[a-zA-Z0-9]{1,9}` no XSD);
- o **endpoint de DANFSE funciona** para elas, sem login nem certificado;
- **o `baixar_danfse` atual não precisa ser reescrito.**

**O único problema que resta** é obter o código programaticamente:

| Onde procurei | Resultado |
|---|---|
| JSON da emissão / consulta | ❌ as chaves são só `tipoAmbiente`, `versaoAplicativo`, `dataHoraProcessamento`, `nfseXmlGZipB64`, `erros` |
| XML da NFS-e | ❌ a string `gQZUcnVoK` não aparece; nenhum campo alfanumérico misto |
| Derivação de `nNFSe`, da chave ou do nome do arquivo | ❌ base62 em 3 alfabetos não bate com nada |
| QR do próprio DANFSe | ✅ está lá — mas é **circular** (precisa do PDF para obter o código que busca o PDF) |

Como não é derivável, é token gerado no servidor.

> ### ⛔ RESPOSTA DA SEMF (2026-10-02): a API **não devolve** o `codigoVerificacao`
> **em nenhum campo.** Confirmado por eles. A circularidade é real e oficial:
> o código existe, é obrigatório na URL do DANFSE, e não há como obtê-lo pela
> API de DPS.

**Pergunta de acompanhamento que precisa ser feita** (a SEMF respondeu a
pergunta estreita, mas a necessidade continua): *"sem o `codigoVerificacao`,
como obter o DANFSE de uma NFS-e emitida por DPS, de forma programática?"*
Pode existir endpoint por chave de acesso, ou pelo ADN nacional.

**Pergunta original (respondida):**

> A API de DPS não devolve o `codigoVerificacao` em nenhum campo, mas ele
> existe e é obrigatório na URL do DANFSE. Como obtê-lo programaticamente?

Isso torna a opção "gerar o DANFSe do XML" **desnecessária** se eles
responderem — provavelmente é só um campo que faltou expor.

#### O que a investigação no portal esgotou (2026-10-02)

- **O código de verificação NÃO existe mais no documento.** O DANFSe v2.0 se
  identifica por **chave de acesso + QR code**; o rodapé diz que a autenticidade
  se verifica "pela leitura deste código QR ou pela consulta da chave de acesso
  no portal nacional". Não há campo de código no PDF.
- **O PDF do portal não tem URL própria:** é renderizado dentro de
  `notaFiscalList.jsf` por postback JSF, na sessão logada. Não dá para chamar.
- **A consulta pública "Autenticidade"** (`/paginas/portal/#/autenticidade`,
  sem captcha) ainda pede os 4 campos antigos: CNPJ + Número da NFSe +
  Inscrição Municipal + **Código de verificação**. O portal público segue
  ancorado num dado que a API de DPS não devolve.
- **A "Documentação API" do portal** (`#/api`) não documenta endpoint de
  DANFSE — repete XSDs, anexos e as duas URLs, mais duas orientações do mundo
  ABRASF (CNAE com 9 posições, UF=EX para exterior).
- **A consulta pública nacional** (nfse.gov.br/consultapublica) tem **hCaptcha**
  e só enxerga produção — inviável para automação, por desenho.
- O endpoint antigo de DANFSE responde **HTTP 500 idêntico** para nota
  existente e inexistente (`Could not find MessageBodyWriter ... media type:
  application/pdf` — bug deles ao serializar o erro), então não serve nem para
  testar hipóteses de código.

**Anomalia a reportar:** no DANFSe da nota 2898 o campo "CHAVE DE ACESSO DA
NFS-E" aparece **vazio** (`-`), embora a API tenha devolvido a chave.

Opções, em ordem de preferência:
1. **Perguntar à SEMF** se existe DANFSE por chave de acesso (é a pergunta 3 da
   Fase 0, agora com evidência concreta de que as URLs óbvias não existem).
2. Descobrir se o portal municipal ainda atribui código de verificação às notas
   emitidas por DPS — se sim, o `baixar_danfse` atual continua servindo.
3. **Gerar o DANFSe a partir do XML** — reavaliado para CIMA depois da
   investigação: o documento é o **DANFSe v2.0, layout padronizado nacional**,
   não uma diagramação nossa. Temos o XML completo e o conteúdo do QR é
   especificado pelo padrão. É a única saída que não depende de terceiros.

### Fase 4 (original) — Consulta, idempotência e cancelamento
- `GET /nfse/dps/{id}` — **implementar junto com a Fase 3, não depois**: é o que
  evita nota duplicada quando a resposta do POST se perde.
- `GET /nfse/{chaveAcesso}` — consulta.
- `POST /nfse/{chaveAcesso}/eventos` — cancelamento (`pedidoRegistroEventoXmlGZipB64`,
  esquemas `pedRegEvento_v1.01.xsd` / `tiposEventos_v1.01.xsd`). Caminho que hoje
  não existe no pipeline e passa a existir de graça.

### Fase 5 — PDF
Conforme o que a Fase 0.3 responder.

### ✅ Fase 6 FEITA — flag `NFSE_MODO` (2026-10-02)

`nfse_emitir_pipeline.py` passa a escolher o backend:

- **`NFSE_MODO=abrasf`** (padrão) — o caminho de hoje, **byte a byte igual**:
  o diff da branch ABRASF é só indentação. Enquanto ninguém virar a chave,
  nada muda no fluxo que atende paciente.
- **`NFSE_MODO=dps`** — emite pelo padrão nacional, uma DPS por item
  (o nacional não tem lote), via `emitir_via_dps()`.

Coleta, aprovação no WhatsApp, `nfse_ignorar.py` e o agendamento de entrega
continuam idênticos. Voltar atrás é mudar uma variável de ambiente — sem
deploy de código.

**Testado de ponta a ponta em homologação** com um `pending_nfse.json`
fictício de 2 itens:

```
✅ *1* nota(s) emitida(s) — protocolo (DPS: sem lote):
• NFSe *2896* — MARIA DA SILVA SANTOS (consulta) ⚠️ sem telefone (não enviada)

⚠️ *PDF não enviado* (emissão por DPS ainda não tem DANFSE):
• NFSe *2896* — MARIA DA SILVA SANTOS — a nota FOI emitida; o PDF precisa ser enviado à mão

❌ Falharam: PACIENTE SEM CEP
Mensagens do servidor: ['PACIENTE SEM CEP: cadastro incompleto, faltou CEP']
```

Três decisões que valem registro:

1. **PDF pendente aparece no resumo, não no stderr.** Sem isso, em modo DPS a
   nota seria marcada como emitida e o paciente simplesmente nunca receberia o
   PDF — o `try/except` existente engoliria a falha num aviso que ninguém lê.
2. **Cadastro incompleto é barrado ANTES de enviar**, com o campo que falta
   nomeado. É a lição do "L999 = CEP faltando" aplicada na entrada.
3. **`nDPS` é uma sequência separada** (`nfse_dps_state.json`), independente do
   RPS. O `main()` casa item ↔ nota pela chave de RPS, então `emitir_via_dps()`
   recebe essa chave e devolve o `nDPS` num campo à parte — devolver o nDPS
   como chave fazia o `main()` marcar como falha uma emissão bem-sucedida
   (bug que só apareceu no teste de ponta a ponta).

⚠️ **Falta para virar a chave em produção:** o DANFSE (Fase 5). Hoje, em modo
DPS, a nota é emitida mas o PDF não vai ao paciente. Não ligue `NFSE_MODO=dps`
em produção antes de resolver isso.

### Fase 6 (original) — Integrar com feature flag
- `NFSE_MODO=abrasf|dps` (default `abrasf`). O `nfse_emitir.py` escolhe o
  backend; **todo o resto do pipeline fica idêntico**.
- Permite voltar atrás numa variável de ambiente, sem deploy de código.

### Fase 7 — Produção, uma nota
- Uma nota real de menor valor, conferida no portal antes de liberar o resto.
- Só depois `NFSE_MODO=dps` como padrão.
- Manter o caminho ABRASF funcional por pelo menos um ciclo de faturamento.

## Riscos

| Risco | Mitigação |
|---|---|
| Campos de IBS/CBS errados → nota errada com efeito fiscal | Fase 0.1 com o contador antes de qualquer código; Fase 7 com uma nota só |
| Certificado recusado no mTLS | Fase 1 isola isso antes de investir no leiaute |
| DANFSE sem caminho no modelo novo | Fase 0.3; se travar, manter o portal atual enquanto durar a coexistência |
| ABRASF desligado sem aviso | Fase 0.2; o flag da Fase 6 permite virar na hora |
| Homologação com dado real de paciente | Usar dados fictícios; a homologação é ambiente da prefeitura, não nosso |
| **Nota duplicada** se a resposta do POST se perder | `GET /nfse/dps/{id}` antes de qualquer retry — na v1, não depois |
| E1206: validação consulta a LCR do nosso certificado pela rede | Conferir na Fase 1 que a VM alcança o CRL DistributionPoint da AC |
| Reaproveitar `_sign_lote()` por engano | Ele usa prefixo `ns2` + `URI=""` → E1228. Só a `sign()` por documento serve |

## Fontes

- Página SEMF: <https://cartadeservicos-semf.pmt.pi.gov.br/dps>
- XSD v1.01: <https://www.gov.br/nfse/pt-br/biblioteca/documentacao-tecnica/documentacao-atual/nfse-esquemas_xsd-v1-01-20260209.zip>
- Anexo I: <https://www.gov.br/nfse/pt-br/biblioteca/documentacao-tecnica/documentacao-atual/anexo_i-sefin_adn-dps_nfse-snnfse-v1-01-20260209.xlsx>
- Guia da API (DSF V7) e XML modelo: links na página SEMF
- Nota Técnica SE/CGNFS-e nº 009, de junho de 2026 (adaptações de leiaute p/ IBS/CBS)
- Contato SEMF: notafiscaleletronica.semf@pmt.pi.gov.br
