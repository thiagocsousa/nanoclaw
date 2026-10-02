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

## Fases

Cada fase é verificável sozinha. Nenhuma toca produção até a Fase 6.

### Fase 0 — Destravar as decisões que não são técnicas
Bloqueiam o resto; começar por aqui.
1. **Contador** — ✅ **respondido em 2026-10-02** (conferido na tela do próprio
   emissor municipal):
   - `CST` = **200** (Alíquota reduzida);
   - `cClassTrib` = **200029** (Fornecimento dos serviços de saúde humana, Anexo III);
   - `cNBS` por categoria: consulta e exames = **1.2301.21.00** → `123012100`;
     cirurgia = **1.2301.11.00** → `123011100` (o XSD exige 9 dígitos sem pontos).

   Já aplicados no `nfse_dps.py`; as 5 variações de serviço da clínica validam.

   **Nada mais precisa ser enviado pela redução de alíquota:** a regra confirma
   que `pRedutor` só vale para compra governamental (E1522/E1523, exige
   `tpEnteGov`) e que `pAliqEfetUF/Mun/CBS` ficam na **NFS-e de resposta**,
   calculados pelo autorizador a partir do `cClassTrib`. A DPS fecha com
   CST + cClassTrib.

   **Ainda pendentes** (menores): `cIndOp` — hoje com `100301`, copiado do XML
   modelo, é o único campo de IBS/CBS não confirmado — além de `cTribNac` e
   `cTribMun`.
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

| Campo | Valor | Origem |
|---|---|---|
| `cTribNac` | `040301` | 04.03.01 "Hospitais e congêneres" (tela do emissor) |
| `cTribMun` | `004` | 04.03.01.004 "atividade médica ambulatorial…" (tela) |
| `cNBS` | `123011900` | 1.2301.19.00 (tela) — **ver conflito abaixo** |
| `cIndOp` | `030101` | Anexo C: serviço prestado fisicamente sobre a pessoa |
| `CST` | `200` | alíquota reduzida |
| `cClassTrib` | `200029` | saúde humana, Anexo III |
| `serie` | `10001` | faixa do contribuinte (ver L0022) |

⚠️ **Conflito de NBS a resolver com o contador:** ele indicou 1.2301.21.00
(consulta/exame) e 1.2301.11.00 (cirurgia); a tela do emissor mostra
1.2301.19.00 pareado com 04.03.01. Como o par NBS ↔ `cTribNac` é validado pela
prefeitura (L0010), adotamos o do portal — mas isso precisa de confirmação,
porque pode variar por categoria de serviço.

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

#### ✅ RESOLVIDO EM PARTE: o DANFSE funciona, falta só obter o código

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

Como não é derivável, é token gerado no servidor. **Logo, a pergunta à SEMF
virou cirúrgica e fácil de responder:**

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
