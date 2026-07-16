#!/usr/bin/env python3
"""
Emissor de NFS-e — Teresina/PI · padrão ABRASF 2.03 · operação GerarNfse (síncrona).

ESQUELETO config-driven. Prestador (CARDIOMED) já preenchido dos documentos oficiais.
Pendências marcadas com  # TODO(contador) / TODO(cert) / TODO(homolog) — plugar e testar
em HOMOLOGAÇÃO antes de qualquer emissão real.

Regras já embutidas:
  - CNAE + descrição padronizada por categoria de serviço (consulta/cirurgia/exame),
    a partir do cartão de inscrição municipal da CARDIOMED.
  - Retenção conforme tomador: PESSOA FÍSICA (CPF) → sem retenção;
    PESSOA JURÍDICA (CNPJ) → retenções federais (alíquotas a confirmar com contador).

Segredos SEMPRE via env (nunca hardcode — ver feedback_credentials):
  NFSE_CERT_PATH / NFSE_CERT_PASSWORD   certificado A1 (e-CNPJ CARDIOMED)
  NFSE_AMBIENTE                         'homologacao' (default) | 'producao'
  NFSE_URL_HOMOLOGACAO                  URL do webservice de homologação de Teresina

Deps: pip install lxml signxml requests-pkcs12 cryptography

Uso (teste):
  python3 nfse_emitir.py --categoria cirurgia --valor 3900.00 \\
      --tomador-nome "FULANO" --tomador-cpf 12345678900 --rps-numero 1 --dry-run
"""

import argparse
import os
import json
from datetime import datetime, date
from decimal import Decimal, ROUND_HALF_UP

from lxml import etree

NS = "http://www.abrasf.org.br/nfse.xsd"
SOAP_NS = "http://schemas.xmlsoap.org/soap/envelope/"
WS_NS = "http://nfse.abrasf.org.br"        # namespace da operação (confirmado no WSDL de Teresina)
IBGE_TERESINA = "2211001"

# ─────────────────────────── Prestador (CARDIOMED) ───────────────────────────
# Extraído de _Inscrição municipal.pdf + _CNPJ 2026.pdf (2026-07-11).
PRESTADOR = {
    "cnpj": "63521918000104",
    "inscricao_municipal": "0509477",            # 050.947-7
    "razao_social": "CARDIOMED - CLINICA DE HIPERTENSAO DO PIAUI LTDA",
    "codigo_municipio": IBGE_TERESINA,           # município de incidência = Teresina
}

# Identificação profissional — anexada à Discriminação de toda NF (CRM/RQE obrigatórios).
# '\s\n' é a quebra de linha exigida pelo manual ABRASF p/ os campos Discriminacao/OutrasInformacoes.
PROFISSIONAL = (
    "SERVIÇOS MÉDICOS PRESTADOS PELA DRA. MARINA COSTA CARVALHO DE SOUSA"
    r"\s\nCRM 3816\s\nRQE 1949"
)

# ───────── Serviços: categoria → CNAE + item LC116 + descrição padronizada ─────
# CNAEs e descrições vêm do cartão de inscrição municipal da CARDIOMED.
# TODO(contador): confirmar o item da lista de serviço (LC116) de cada categoria.
# Categoria → CNAE + item LC116 (do cartão de inscrição municipal da CARDIOMED).
CATEGORIAS = {
    "consulta": {"cnae": "8630503", "item_lista": "4.01"},
    "cirurgia": {"cnae": "8630501", "item_lista": "4.03"},
    "exame":    {"cnae": "8630502", "item_lista": "4.03"},
}

# Serviço específico → categoria + descrição padronizada (base da Discriminação da NF).
# TODO(usuário): confirmar descrições de consulta / lente_faco / refrativa.
SERVICOS = {
    "consulta":   {"categoria": "consulta", "descricao": "CONSULTA OFTALMOLÓGICA"},
    "topografia": {"categoria": "exame",    "descricao": "EXAME TOPOGRAFIA CORNEANA"},
    "mapeamento": {"categoria": "exame",    "descricao": "EXAME MAPEAMENTO DE RETINA"},
    "lente_faco": {"categoria": "cirurgia", "descricao": (
        "CIRURGIA DE FACECTOMIA COM COMPLEMENTAÇÃO DE LENTE INTRAOCULAR, POR OPÇÃO DO(A) PACIENTE."
        r"\s\nNÃO COBERTA PELO PLANO DE SAÚDE, CIENTE QUE NÃO HAVERÁ REEMBOLSO DO CONVÊNIO.")},
    "refrativa":  {"categoria": "cirurgia", "descricao": "CIRURGIA REFRATIVA"},
    "pterigio":   {"categoria": "cirurgia", "descricao": "CIRURGIA DE PTERIGIO"},
    "yag":        {"categoria": "cirurgia", "descricao": "PROCEDIMENTO DE CAPSULOTOMIA POR YAG LASER"},
}

# ─────────────────────────────── Tributação ──────────────────────────────────
# Confirmado na tela do sistema (2026-07-11): ISS alíquota 3%, calculado, não retido.
# Regime normal (não-Simples) — inferido do ISS calculado na nota + retenções federais.
TRIBUTACAO = {
    "optante_simples_nacional": "2",   # 2=Não (regime normal)
    "incentivo_fiscal": "2",           # 1=Sim 2=Não
    "codigo_tributacao_municipio": "", # se Teresina exigir — TODO(contador)
    "aliquota": "3",                   # ISS 3% (confirmado na tela)
    "exigibilidade_iss": "1",          # 1=Exigível
    "regime_especial_tributacao": "",  # ex "3"=Soc. profissionais — TODO(contador)
}

# Retenções federais para tomador PESSOA JURÍDICA (PF zera tudo).
# Confirmado na tela do sistema (2026-07-11). Valores em % (formato 00.00).
RETENCOES_PJ = {
    "pis": "0.65",
    "cofins": "3.00",
    "csll": "1.00",
    "ir": "1.50",
    "inss": "0",       # não retém INSS
}

RPS_SERIE = os.environ.get("NFSE_RPS_SERIE", "1")   # TODO(contador): série do RPS
RPS_TIPO = "1"                                        # 1=RPS

AMBIENTES = {
    "homologacao": os.environ.get("NFSE_URL_HOMOLOGACAO", ""),  # TODO(homolog)
    "producao": "https://notafiscal.teresina.pi.gov.br/notafiscal-abrasfv203-ws/NotaFiscalSoap",
}


# ─────────────────────────────── helpers ─────────────────────────────────────
def _dec(v) -> str:
    return str(Decimal(str(v)).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP))


def _only_digits(s: str) -> str:
    return "".join(c for c in (s or "") if c.isdigit())


def _sub(parent, tag, text=None):
    if text is None or text == "":
        return None
    el = etree.SubElement(parent, f"{{{NS}}}{tag}")
    el.text = str(text)
    return el


def tomador_is_pj(tomador: dict) -> bool:
    """PJ se tiver CNPJ (14 dígitos); caso contrário PF."""
    doc = _only_digits(tomador.get("cnpj") or tomador.get("documento") or "")
    return len(doc) == 14 or bool(tomador.get("cnpj"))


def retencoes(valor, tomador: dict) -> dict:
    """Retenções federais em R$. Vazio para PF; calculadas para PJ."""
    if not tomador_is_pj(tomador):
        return {}
    v = Decimal(str(valor))
    out = {}
    for k in ("pis", "cofins", "inss", "ir", "csll"):
        aliq = Decimal(str(RETENCOES_PJ.get(k, "0") or "0"))
        if aliq > 0:
            out[k] = _dec(v * aliq / 100)
    return out


# ─────────────────────── montagem do XML (GerarNfseEnvio) ─────────────────────
def build_declaracao(servico: dict, tomador: dict, competencia: date, rps_numero: int,
                     inf_id: str) -> etree._Element:
    """Monta InfDeclaracaoPrestacaoServico (ordem conforme schema ABRASF 2.03)."""
    serv_key = servico.get("servico", "consulta")
    smap = SERVICOS.get(serv_key, SERVICOS["consulta"])
    cmap = CATEGORIAS[smap["categoria"]]
    valor = servico["valor"]
    base_desc = servico.get("discriminacao") or smap["descricao"]
    # A discriminação SEMPRE inicia com a identificação da Dra. Marina, depois o serviço.
    discriminacao = f"{PROFISSIONAL}\\s\\n{base_desc}"
    pj = tomador_is_pj(tomador)

    inf = etree.Element(f"{{{NS}}}InfDeclaracaoPrestacaoServico", Id=inf_id, nsmap={None: NS})

    # Rps
    rps = etree.SubElement(inf, f"{{{NS}}}Rps")
    ident = etree.SubElement(rps, f"{{{NS}}}IdentificacaoRps")
    _sub(ident, "Numero", rps_numero)
    _sub(ident, "Serie", RPS_SERIE)
    _sub(ident, "Tipo", RPS_TIPO)
    _sub(rps, "DataEmissao", datetime.now().strftime("%Y-%m-%dT%H:%M:%S"))
    _sub(rps, "Status", "1")

    _sub(inf, "Competencia", competencia.strftime("%Y-%m-%d"))

    # Servico — ordem: Valores, IssRetido, ItemListaServico, CodigoCnae,
    # CodigoTributacaoMunicipio, Discriminacao, CodigoMunicipio, ExigibilidadeISS
    serv = etree.SubElement(inf, f"{{{NS}}}Servico")
    valores = etree.SubElement(serv, f"{{{NS}}}Valores")
    _sub(valores, "ValorServicos", _dec(valor))
    ret = retencoes(valor, tomador)  # {} p/ PF (zera retenções), calculado p/ PJ
    _sub(valores, "ValorPis", ret.get("pis"))
    _sub(valores, "ValorCofins", ret.get("cofins"))
    _sub(valores, "ValorInss", ret.get("inss"))
    _sub(valores, "ValorIr", ret.get("ir"))
    _sub(valores, "ValorCsll", ret.get("csll"))
    # ISSQN sempre igual (independe de PF/PJ): alíquota 3%, ISS calculado, não retido.
    aliq = TRIBUTACAO["aliquota"]
    if aliq:
        _sub(valores, "ValorIss", _dec(Decimal(str(valor)) * Decimal(aliq) / 100))
        _sub(valores, "Aliquota", aliq)
    _sub(serv, "IssRetido", "2")  # ISS não é retido (prestador recolhe)
    _sub(serv, "ItemListaServico", cmap["item_lista"])
    # Teresina exige CNAE com 9 posições e zeros à DIREITA (ex: 8630503 → 863050300).
    _sub(serv, "CodigoCnae", str(cmap["cnae"]).ljust(9, "0"))
    _sub(serv, "CodigoTributacaoMunicipio", TRIBUTACAO["codigo_tributacao_municipio"])
    _sub(serv, "Discriminacao", discriminacao)
    _sub(serv, "CodigoMunicipio", PRESTADOR["codigo_municipio"])
    _sub(serv, "ExigibilidadeISS", TRIBUTACAO["exigibilidade_iss"])

    # Prestador
    prest = etree.SubElement(inf, f"{{{NS}}}Prestador")
    cc = etree.SubElement(prest, f"{{{NS}}}CpfCnpj")
    _sub(cc, "Cnpj", PRESTADOR["cnpj"])
    _sub(prest, "InscricaoMunicipal", PRESTADOR["inscricao_municipal"])

    # TomadorServico (opcional no schema) — CPF (PF) ou CNPJ (PJ)
    doc = tomador.get("cnpj") or tomador.get("cpf") or tomador.get("documento")
    if doc or tomador.get("nome"):
        tom = etree.SubElement(inf, f"{{{NS}}}Tomador")
        if doc:
            it = etree.SubElement(tom, f"{{{NS}}}IdentificacaoTomador")
            cpfcnpj = etree.SubElement(it, f"{{{NS}}}CpfCnpj")
            if pj:
                _sub(cpfcnpj, "Cnpj", _only_digits(doc))
            else:
                _sub(cpfcnpj, "Cpf", _only_digits(doc))
        _sub(tom, "RazaoSocial", tomador.get("nome"))
        end = tomador.get("endereco") or {}
        if any(end.values()):
            e = etree.SubElement(tom, f"{{{NS}}}Endereco")
            _sub(e, "Endereco", end.get("logradouro"))
            _sub(e, "Numero", end.get("numero"))
            _sub(e, "Complemento", end.get("complemento"))
            _sub(e, "Bairro", end.get("bairro"))
            _sub(e, "CodigoMunicipio", end.get("codigo_municipio"))
            _sub(e, "Uf", end.get("uf"))
            _sub(e, "Cep", _only_digits(end.get("cep", "")))

    if TRIBUTACAO["regime_especial_tributacao"]:
        _sub(inf, "RegimeEspecialTributacao", TRIBUTACAO["regime_especial_tributacao"])
    _sub(inf, "OptanteSimplesNacional", TRIBUTACAO["optante_simples_nacional"])
    _sub(inf, "IncentivoFiscal", TRIBUTACAO["incentivo_fiscal"])
    return inf


def build_gerar_nfse_envio(inf: etree._Element) -> etree._Element:
    envio = etree.Element(f"{{{NS}}}GerarNfseEnvio", nsmap={None: NS})
    decl = etree.SubElement(envio, f"{{{NS}}}Rps")  # tcDeclaracaoPrestacaoServico
    decl.append(inf)
    return envio


# ─────────────────────────── assinatura ABRASF ───────────────────────────────
def sign(envio: etree._Element, inf_id: str, pfx_path: str, pfx_password: str) -> etree._Element:
    """
    Assina InfDeclaracaoPrestacaoServico (Reference #inf_id) com o A1.
    ABRASF: enveloped + C14N (xml-c14n-20010315), RSA-SHA1, DigestMethod SHA-1,
    KeyInfo só com X509Certificate. <Signature> fica dentro de <Rps>, irmã de Inf...
    NOTA: usa xmlsec (compatível com validador Java, ao contrário do signxml).
    """
    import xmlsec

    decl = envio.find(f"{{{NS}}}Rps")               # tcDeclaracaoPrestacaoServico
    inf = decl.find(f"{{{NS}}}InfDeclaracaoPrestacaoServico")
    inf.set("Id", inf_id)

    sig = xmlsec.template.create(
        decl, xmlsec.constants.TransformInclC14N, xmlsec.constants.TransformRsaSha1)
    ref = xmlsec.template.add_reference(
        sig, xmlsec.constants.TransformSha1, uri="#" + inf_id)
    xmlsec.template.add_transform(ref, xmlsec.constants.TransformEnveloped)
    xmlsec.template.add_transform(ref, xmlsec.constants.TransformInclC14N)
    _rich_x509(sig)                                 # KeyInfo completo (ver _rich_x509)
    decl.append(sig)                                # <Signature> irmã da Inf, dentro do Rps

    xmlsec.tree.add_ids(envio, ["Id"])
    ctx = xmlsec.SignatureContext()
    ctx.key = xmlsec.Key.from_file(
        pfx_path, xmlsec.constants.KeyDataFormatPkcs12, pfx_password)
    ctx.sign(sig)

    # Remove quebras de linha dos campos base64 (SignatureValue/X509Certificate vêm
    # multi-linha; validadores ABRASF rígidos rejeitam). Fora do SignedInfo → seguro.
    ds = "http://www.w3.org/2000/09/xmldsig#"
    for tag in ("SignatureValue", "X509Certificate"):
        for el in sig.iter(f"{{{ds}}}{tag}"):
            if el.text:
                el.text = "".join(el.text.split())
    return envio


# ─────────────────────── LOTE (RecepcionarLoteRpsSincrono) ───────────────────
_DS_NS = "http://www.w3.org/2000/09/xmldsig#"


def _rich_x509(sig):
    """KeyInfo COMPLETO exigido pelo DSF/Teresina: X509Data com SubjectName +
    IssuerSerial (IssuerName+SerialNumber) + Certificate. KeyInfo só com
    X509Certificate faz o validador Java deles estourar NPE ('obj must not be
    null') — ele desreferencia SubjectName/IssuerSerial. (Descoberto 2026-07-15.)"""
    import xmlsec
    ki = xmlsec.template.ensure_key_info(sig)
    x = xmlsec.template.add_x509_data(ki)
    xmlsec.template.x509_data_add_subject_name(x)
    iss = xmlsec.template.x509_data_add_issuer_serial(x)
    xmlsec.template.x509_issuer_serial_add_issuer_name(iss)
    xmlsec.template.x509_issuer_serial_add_serial_number(iss)
    xmlsec.template.x509_data_add_certificate(x)


def _u(parent, tag, text=None):
    """SubElement SEM namespace (unqualified). O DSF/Teresina exige que TODOS os
    elementos do lote sejam unqualified (só a raiz declara ns2/ns3; a Signature usa
    prefixo ns2). elementFormDefault=unqualified no WSDL."""
    if text is None or text == "":
        return None
    el = etree.SubElement(parent, tag)
    el.text = str(text)
    return el


def _build_inf_u(servico, tomador, competencia, rps_numero, rps_id):
    """InfDeclaracaoPrestacaoServico UNQUALIFIED (mesmos campos/ordem do schema).
    DataEmissao = DATE (xs:date). O Id vai no <Rps> interno (tcInfRps)."""
    smap = SERVICOS.get(servico.get("servico", "consulta"), SERVICOS["consulta"])
    cmap = CATEGORIAS[smap["categoria"]]
    valor = servico["valor"]
    base_desc = servico.get("discriminacao") or smap["descricao"]
    discriminacao = f"{PROFISSIONAL}\\s\\n{base_desc}"   # cabeçalho Dra. Marina + serviço
    pj = tomador_is_pj(tomador)

    inf = etree.Element("InfDeclaracaoPrestacaoServico")
    rps = etree.SubElement(inf, "Rps")
    rps.set("Id", rps_id)
    ident = etree.SubElement(rps, "IdentificacaoRps")
    _u(ident, "Numero", rps_numero)
    _u(ident, "Serie", RPS_SERIE)
    _u(ident, "Tipo", RPS_TIPO)
    _u(rps, "DataEmissao", competencia.strftime("%Y-%m-%d"))
    _u(rps, "Status", "1")
    _u(inf, "Competencia", competencia.strftime("%Y-%m-%d"))

    serv = etree.SubElement(inf, "Servico")
    valores = etree.SubElement(serv, "Valores")
    _u(valores, "ValorServicos", _dec(valor))
    ret = retencoes(valor, tomador)   # {} p/ PF; calculado p/ PJ
    _u(valores, "ValorPis", ret.get("pis"))
    _u(valores, "ValorCofins", ret.get("cofins"))
    _u(valores, "ValorInss", ret.get("inss"))
    _u(valores, "ValorIr", ret.get("ir"))
    _u(valores, "ValorCsll", ret.get("csll"))
    aliq = TRIBUTACAO["aliquota"]
    if aliq:
        _u(valores, "ValorIss", _dec(Decimal(str(valor)) * Decimal(aliq) / 100))
        _u(valores, "Aliquota", aliq)
    _u(serv, "IssRetido", "2")
    _u(serv, "ItemListaServico", cmap["item_lista"])
    _u(serv, "CodigoCnae", str(cmap["cnae"]).ljust(9, "0"))   # 9 pos, zeros à DIREITA
    _u(serv, "CodigoTributacaoMunicipio", TRIBUTACAO["codigo_tributacao_municipio"])
    _u(serv, "Discriminacao", discriminacao)
    _u(serv, "CodigoMunicipio", PRESTADOR["codigo_municipio"])
    _u(serv, "ExigibilidadeISS", TRIBUTACAO["exigibilidade_iss"])

    prest = etree.SubElement(inf, "Prestador")
    cc = etree.SubElement(prest, "CpfCnpj")
    _u(cc, "Cnpj", PRESTADOR["cnpj"])
    _u(prest, "InscricaoMunicipal", PRESTADOR["inscricao_municipal"])

    # Tomador — Endereco é OBRIGATÓRIO p/ atividade médica (senão dá L999).
    doc = tomador.get("cnpj") or tomador.get("cpf") or tomador.get("documento")
    if doc or tomador.get("nome"):
        tom = etree.SubElement(inf, "Tomador")
        if doc:
            it = etree.SubElement(tom, "IdentificacaoTomador")
            cpfcnpj = etree.SubElement(it, "CpfCnpj")
            _u(cpfcnpj, "Cnpj" if pj else "Cpf", _only_digits(doc))
        _u(tom, "RazaoSocial", tomador.get("nome"))
        end = tomador.get("endereco") or {}
        if any(end.values()):
            ed = etree.SubElement(tom, "Endereco")
            _u(ed, "Endereco", end.get("logradouro"))
            _u(ed, "Numero", end.get("numero"))
            _u(ed, "Complemento", end.get("complemento"))
            _u(ed, "Bairro", end.get("bairro"))
            _u(ed, "CodigoMunicipio", end.get("codigo_municipio"))
            _u(ed, "Uf", end.get("uf"))
            _u(ed, "Cep", _only_digits(end.get("cep", "")))

    if TRIBUTACAO["regime_especial_tributacao"]:
        _u(inf, "RegimeEspecialTributacao", TRIBUTACAO["regime_especial_tributacao"])
    _u(inf, "OptanteSimplesNacional", TRIBUTACAO["optante_simples_nacional"])
    _u(inf, "IncentivoFiscal", TRIBUTACAO["incentivo_fiscal"])
    return inf


def _sign_lote(envio, pfx_path, pfx_password):
    """Assinatura ÚNICA do EnviarLoteRpsSincronoEnvio (receita validada 2026-07-15):
    prefixo ns2:, Reference URI="" (documento inteiro), enveloped + C14N inclusiva,
    RSA-SHA1 / SHA1, KeyInfo só com X509Certificate, base64 sem quebra de linha.
    NÃO assina cada RPS nem usa #Id — uma assinatura só, no nível do envio."""
    import xmlsec
    sig = xmlsec.template.create(
        envio, xmlsec.constants.TransformInclC14N, xmlsec.constants.TransformRsaSha1, ns="ns2")
    ref = xmlsec.template.add_reference(sig, xmlsec.constants.TransformSha1, uri="")
    xmlsec.template.add_transform(ref, xmlsec.constants.TransformEnveloped)
    xmlsec.template.add_transform(ref, xmlsec.constants.TransformInclC14N)
    xmlsec.template.add_x509_data(xmlsec.template.ensure_key_info(sig))
    envio.append(sig)
    ctx = xmlsec.SignatureContext()
    ctx.key = xmlsec.Key.from_file(
        pfx_path, xmlsec.constants.KeyDataFormatPkcs12, pfx_password)
    ctx.sign(sig)
    for tag in ("SignatureValue", "X509Certificate"):
        for el in sig.iter(f"{{{_DS_NS}}}{tag}"):
            if el.text:
                el.text = "".join(el.text.split())


def build_lote_sincrono(items, numero_lote, pfx_path, pfx_password):
    """EnviarLoteRpsSincronoEnvio no formato aceito pelo DSF/Teresina:
    raiz e filhos SEM namespace; raiz declara ns2(xmldsig)+ns3(nfse.xsd); UMA
    assinatura no nível do envio (URI="").
    items: lista de {servico, tomador, rps_numero}."""
    envio = etree.Element("EnviarLoteRpsSincronoEnvio", nsmap={"ns2": _DS_NS, "ns3": NS})
    lote = etree.SubElement(envio, "LoteRps")
    _u(lote, "NumeroLote", numero_lote)
    cc = etree.SubElement(lote, "CpfCnpj")
    _u(cc, "Cnpj", PRESTADOR["cnpj"])
    _u(lote, "InscricaoMunicipal", PRESTADOR["inscricao_municipal"])
    _u(lote, "QuantidadeRps", len(items))
    lista = etree.SubElement(lote, "ListaRps")
    for it in items:
        rps = etree.SubElement(lista, "Rps")
        rps.append(_build_inf_u(it["servico"], it["tomador"], date.today(),
                                it["rps_numero"], f"rps{it['rps_numero']}"))
    _sign_lote(envio, pfx_path, pfx_password)
    return envio


def soap_envelope_lote(envio: etree._Element) -> str:
    env = etree.Element(f"{{{SOAP_NS}}}Envelope", nsmap={"soapenv": SOAP_NS})
    etree.SubElement(env, f"{{{SOAP_NS}}}Header")
    body = etree.SubElement(env, f"{{{SOAP_NS}}}Body")
    # operação com namespace PREFIXADO (nfseWs) — se for default xmlns, força
    # xmlns="" nos filhos do envio e quebra a assinatura.
    op = etree.SubElement(body, f"{{{WS_NS}}}RecepcionarLoteRpsSincrono", nsmap={"nfseWs": WS_NS})
    op.append(envio)
    return etree.tostring(env, encoding="unicode")


# ─────────────────── resposta do lote + DANFSE (PDF) ─────────────────────────
def parse_resposta_lote(xml_text: str) -> dict:
    """Extrai {protocolo, notas:[{numero, codigo_verificacao, data_emissao}],
    mensagens:[{codigo, mensagem}]} da resposta (namespace-agnóstico)."""
    root = etree.fromstring(xml_text.encode("utf-8"))

    def txt(el, local):
        r = el.xpath(f".//*[local-name()='{local}']/text()")
        return r[0].strip() if r else None

    notas = []
    for nf in root.xpath("//*[local-name()='Nfse']"):
        inf = nf.xpath(".//*[local-name()='InfNfse']")
        base = inf[0] if inf else nf
        # número do RPS (dentro de IdentificacaoRps) p/ mapear a nota → item enviado
        rps = base.xpath(".//*[local-name()='IdentificacaoRps']/*[local-name()='Numero']/text()")
        notas.append({"numero": txt(base, "Numero"),
                      "codigo_verificacao": txt(base, "CodigoVerificacao"),
                      "data_emissao": txt(base, "DataEmissao"),
                      "rps_numero": rps[0].strip() if rps else None})
    msgs = [{"codigo": txt(m, "Codigo"), "mensagem": txt(m, "Mensagem")}
            for m in root.xpath("//*[local-name()='MensagemRetorno']")]
    prot = root.xpath("//*[local-name()='Protocolo']/text()")
    return {"protocolo": prot[0] if prot else None, "notas": notas, "mensagens": msgs}


# Portais DSF de Teresina p/ baixar o DANFSE (PDF público, sem login).
PORTAIS = {
    "homologacao": os.environ.get("NFSE_PORTAL_HOMOLOGACAO", "https://the.dsfweb.com.br"),
    "producao": os.environ.get("NFSE_PORTAL_PRODUCAO", "https://notafiscal.teresina.pi.gov.br"),
}


def baixar_danfse(numero, codigo_verificacao, ambiente="producao", destino=None,
                  cnpj=None, inscricao_municipal=None) -> bytes:
    """Baixa o DANFSE (PDF oficial, com QR) do portal DSF. Endpoint PÚBLICO (sem
    login, sem certificado). Retorna os bytes; se `destino`, salva no arquivo."""
    import requests
    host = PORTAIS[ambiente]
    cnpj = _only_digits(cnpj or PRESTADOR["cnpj"])
    im = inscricao_municipal or PRESTADOR["inscricao_municipal"]
    url = (f"{host}/notafiscal-ws/servico/notafiscal/autenticacao/"
           f"cpfCnpj/{cnpj}/inscricaoMunicipal/{im}/"
           f"numeroNota/{numero}/codigoVerificacao/{codigo_verificacao}")
    r = requests.get(url, timeout=60, verify=False)
    r.raise_for_status()
    if not r.content.startswith(b"%PDF"):
        raise RuntimeError(f"Resposta não é PDF ({r.headers.get('Content-Type')}): {r.text[:200]}")
    if destino:
        with open(destino, "wb") as f:
            f.write(r.content)
    return r.content


def emitir(items, numero_lote, ambiente, pfx_path, pfx_password):
    """Emite o lote (RecepcionarLoteRpsSincrono) e devolve (parsed, raw_xml)."""
    envio = build_lote_sincrono(items, numero_lote, pfx_path, pfx_password)
    raw = send(soap_envelope_lote(envio), ambiente, pfx_path, pfx_password)
    return parse_resposta_lote(raw), raw


# ─────────────────────────────── envio SOAP ──────────────────────────────────
def soap_envelope(envio: etree._Element) -> str:
    """Body > GerarNfse(ns=nfse.abrasf.org.br) > GerarNfseEnvio(nfse.xsd, inline)."""
    env = etree.Element(f"{{{SOAP_NS}}}Envelope", nsmap={"soapenv": SOAP_NS})
    etree.SubElement(env, f"{{{SOAP_NS}}}Header")
    body = etree.SubElement(env, f"{{{SOAP_NS}}}Body")
    gerar = etree.SubElement(body, f"{{{WS_NS}}}GerarNfse", nsmap={None: WS_NS})
    gerar.append(envio)
    return etree.tostring(env, encoding="unicode")


def send(soap_xml: str, ambiente: str, pfx_path: str, pfx_password: str) -> str:
    from requests_pkcs12 import post

    url = AMBIENTES[ambiente]
    if not url:
        raise SystemExit(f"URL do ambiente '{ambiente}' não configurada (NFSE_URL_HOMOLOGACAO).")
    resp = post(
        url,
        data=soap_xml.encode("utf-8"),
        headers={"Content-Type": "text/xml; charset=utf-8", "SOAPAction": ""},
        pkcs12_filename=pfx_path,
        pkcs12_password=pfx_password,
        timeout=60,
    )
    return resp.text


# ─────────────────────────────────── CLI ─────────────────────────────────────
def main():
    ap = argparse.ArgumentParser(description="Emissor NFS-e Teresina (ABRASF 2.03) — GerarNfse")
    ap.add_argument("--json", help="Arquivo JSON com {tomador, servico, rps_numero}")
    ap.add_argument("--servico", choices=list(SERVICOS), default="consulta")
    ap.add_argument("--tomador-nome")
    ap.add_argument("--tomador-cpf")
    ap.add_argument("--tomador-cnpj")
    ap.add_argument("--valor")
    ap.add_argument("--discriminacao", help="Sobrescreve a descrição padronizada da categoria")
    ap.add_argument("--rps-numero", type=int)
    ap.add_argument("--dry-run", action="store_true", help="Só monta o XML e imprime, NÃO envia.")
    args = ap.parse_args()

    if args.json:
        data = json.loads(open(args.json, encoding="utf-8").read())
        tomador, servico, rps_numero = data["tomador"], data["servico"], data["rps_numero"]
    else:
        tomador = {"nome": args.tomador_nome, "cpf": args.tomador_cpf, "cnpj": args.tomador_cnpj}
        servico = {"valor": args.valor, "servico": args.servico,
                   "discriminacao": args.discriminacao}
        rps_numero = args.rps_numero
    if not (servico.get("valor") and rps_numero):
        ap.error("valor e rps_numero são obrigatórios.")

    ambiente = os.environ.get("NFSE_AMBIENTE", "homologacao")
    pfx = os.environ.get("NFSE_CERT_PATH")
    pwd = os.environ.get("NFSE_CERT_PASSWORD")

    inf_id = f"rps{rps_numero}"
    inf = build_declaracao(servico, tomador, date.today(), rps_numero, inf_id)
    envio = build_gerar_nfse_envio(inf)

    if args.dry_run:
        print(etree.tostring(envio, pretty_print=True, encoding="unicode"))
        return
    if not pfx:
        raise SystemExit("NFSE_CERT_PATH não definido — certificado A1 é obrigatório p/ assinar.")
    envio = sign(envio, inf_id, pfx, pwd)
    print(send(soap_envelope(envio), ambiente, pfx, pwd))


if __name__ == "__main__":
    main()
