#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Monta uma DPS (Declaração de Prestação de Serviço) no Padrão Nacional da NFS-e
e valida contra o XSD v1.01. **Fase 2** de docs/NFSE-DPS-MIGRACAO.md.

NÃO faz chamada de rede. NÃO assina (a assinatura é Fase 2b, reaproveitando a
função sign() do nfse_emitir.py). Serve para acertar o leiaute em casa, com
mensagem de erro precisa, em vez de descobrir no retorno enigmático da
prefeitura — ver "L999 = CEP faltando" no histórico.

Uso:
  python3 nfse_dps.py                      # monta com dados fictícios e valida
  python3 nfse_dps.py --out /tmp/dps.xml   # salva o XML gerado
  python3 nfse_dps.py --xsd /caminho/Schemas/1.01

Variáveis: NFSE_XSD_DIR aponta para o diretório Schemas/1.01 dos esquemas
nacionais (zip nfse-esquemas_xsd-v1-01-*.zip do gov.br).
"""
import argparse
import os
import sys
from datetime import datetime, timedelta, timezone
from decimal import Decimal

from lxml import etree

NS = "http://www.sped.fazenda.gov.br/nfse"
TZ = timezone(timedelta(hours=-3))  # America/Fortaleza
IBGE_TERESINA = "2211001"

# ───────────────────────── Parâmetros reais da clínica ───────────────────────
# Espelham o que o nfse_emitir.py (ABRASF) já usa em produção.
# CNPJ e inscrição municipal da CARDIOMED — os MESMOS do nfse_emitir.py (dado
# público de cadastro). Precisam ser os reais: o guia exige que o CNPJ raiz do
# certificado de transmissão bata com o contribuinte declarado na DPS.
PRESTADOR = {
    "CNPJ": os.environ.get("NFSE_CNPJ", "63521918000104"),
    "IM": os.environ.get("NFSE_IM", "0509477"),
    "opSimpNac": "1",           # 1=Não optante pelo Simples Nacional
    "regEspTrib": "0",          # 0=Nenhum. TODO(contador): confirmar
}

# NBS (Nomenclatura Brasileira de Serviços) por categoria — informado pelo
# contador em 2026-10-02. O XSD exige 9 dígitos sem pontos (TSCodNBS).
# ⚠️ CONFLITO A RESOLVER: o contador passou 1.2301.21.00 (consulta/exame) e
# 1.2301.11.00 (cirurgia); já a tela do emissor municipal mostra
# 1.2301.19.00 ("Serviços hospitalares não classificados em subposições
# anteriores") pareado com o código nacional 04.03.01. Como o par NBS ↔
# cTribNac é validado pela prefeitura (erro L0010), vale o que o portal aceita.
# Usando o do portal até o contador confirmar por categoria.
NBS_POR_CATEGORIA = {
    "consulta": os.environ.get("NFSE_NBS_CONSULTA", "123011900"),  # 1.2301.19.00
    "exame":    os.environ.get("NFSE_NBS_EXAME",    "123011900"),
    "cirurgia": os.environ.get("NFSE_NBS_CIRURGIA", "123011900"),
}

# As descrições e a identificação profissional são AS MESMAS usadas hoje em
# produção: importadas do nfse_emitir.py em vez de copiadas, para não existirem
# duas listas divergindo. Se o serviço mudar lá, muda aqui junto.
try:
    from nfse_emitir import SERVICOS as _SERVICOS_ABRASF, PROFISSIONAL as _PROFISSIONAL
except ImportError:  # fora do container (sem lxml/xmlsec do emissor)
    _SERVICOS_ABRASF, _PROFISSIONAL = None, None

SERVICOS = {k: (v["categoria"], v["descricao"]) for k, v in _SERVICOS_ABRASF.items()} \
    if _SERVICOS_ABRASF else {
        # Espelho de emergência — só vale se o import falhar.
        "consulta":   ("consulta", "CONSULTA OFTALMOLÓGICA"),
        "topografia": ("exame",    "EXAME TOPOGRAFIA CORNEANA"),
        "mapeamento": ("exame",    "EXAME MAPEAMENTO DE RETINA"),
        "lente_faco": ("cirurgia", "CIRURGIA DE FACECTOMIA COM LENTE INTRAOCULAR"),
        "refrativa":  ("cirurgia", "CIRURGIA REFRATIVA"),
        "pterigio":   ("cirurgia", "CIRURGIA DE PTERIGIO"),
        "yag":        ("cirurgia", "PROCEDIMENTO DE CAPSULOTOMIA POR YAG LASER"),
    }

PROFISSIONAL = _PROFISSIONAL or (
    "SERVIÇOS MÉDICOS PRESTADOS PELA DRA. MARINA COSTA CARVALHO DE SOUSA"
    r"\s\nCRM 3816\s\nRQE 1949")


SERVICO = {
    # Confirmados na tela do emissor municipal (2026-10-02):
    #   Código Tributação Nacional    = 04.03.01 "Hospitais e congêneres" -> 040301
    #   Código Complementar Municipal = 04.03.01.004 "ATIVIDADE MEDICA AMBULATORIAL
    #     COM RECURSOS PARA REALIZACAO DE EXAMES COMPLEMENTARES" -> cTribMun é
    #     [0-9]{3} no XSD, logo "004".
    # cTribMun é o MESMO campo que o ABRASF chama CodigoTributacaoMunicipio, que
    # vinha vazio (TODO(contador)) porque o endpoint antigo tolerava; a DPS exige
    # (erro L0017) e ainda valida contra o cadastro econômico (L0001).
    "cTribNac": os.environ.get("NFSE_CTRIB_NAC", "040301"),
    "cTribMun": os.environ.get("NFSE_CTRIB_MUN", "004"),
}

ISS = {
    "tribISSQN": "1",           # 1=Operação tributável
    "tpRetISSQN": "1",          # 1=Não retido
    "pAliq": "3",               # 3% — confirmado na tela do sistema
}

# IBS/CBS — Reforma Tributária. Confirmados pelo contador e pela tela do emissor.
IBSCBS = {
    "finNFSe": "0",          # 0 é o único valor aceito pelo XSD
    "indDest": "0",
    "CST": "200",            # 200 = Alíquota reduzida
    "cClassTrib": "200029",  # Serviços de saúde humana (Anexo III) -> redução de 60%
    # 030101 = Anexo C (INDOP_IBSCBS), Art. 11 Inc. III: "serviço prestado
    # fisicamente sobre a pessoa", sufixo 01 = local da prestação. O 100301 do
    # XML modelo é "demais serviços" e a prefeitura recusa com L0008 para saúde.
    "cIndOp": "030101",
}


# Separador da discriminação. NÃO use "\n": o XSD aceita (TSDesc2000 deriva de
# TSStringComQuebraDeLinha), mas o DSF/Teresina DESCARTA as quebras e cola as
# palavras — testado em homologação em 2026-10-02, a nota voltou com
# "...DE SOUSACRM 3816RQE 1949CONSULTA...". Com " - " o texto sobrevive legível.
SEP_DESC = os.environ.get("NFSE_DPS_SEP_DESC", " - ")


def descricao_servico(descricao):
    """Mesma discriminação usada hoje no ABRASF (identificação da Dra. Marina +
    serviço), com o escape '\\s\\n' do manual ABRASF trocado pelo separador que
    a prefeitura preserva."""
    texto = "%s%s%s" % (PROFISSIONAL, SEP_DESC, descricao)
    return texto.replace(r"\s\n", SEP_DESC).replace("\n", SEP_DESC)


# Série da DPS. Regra de Teresina (erro L0022, descoberto em homologação em
# 2026-10-02): a faixa 00001–10000 é EXCLUSIVA do sistema municipal; o
# contribuinte tem que usar 10001–49999. Isso não está no XSD nacional nem no
# Anexo I — só aparece quando se tenta emitir.
SERIE_PADRAO = os.environ.get("NFSE_DPS_SERIE", "10001")


def el(parent, tag, text=None):
    """SubElement no namespace nacional. Nunca usar prefixo: a regra E1228
    rejeita prefixo de namespace na área de dados."""
    e = etree.SubElement(parent, "{%s}%s" % (NS, tag))
    if text is not None:
        e.text = str(text)
    return e


def monta_id(cloc_emi, cnpj, serie, ndps):
    """Id = 'DPS' + 42 dígitos (TSIdDPS): município(7) + tpInsc(1) +
    inscrição(14) + série(5) + nDPS(15)."""
    return "DPS%s%s%s%s%s" % (
        cloc_emi.zfill(7), "2", cnpj.zfill(14), serie.zfill(5), str(ndps).zfill(15),
    )


def monta_dps(tomador, valor, *, servico="consulta", serie=SERIE_PADRAO, ndps=1,
              tp_amb="2", competencia=None):
    """Monta a DPS. tp_amb: 1=Produção, 2=Homologação."""
    if servico not in SERVICOS:
        raise ValueError("serviço desconhecido: %s (use %s)" % (servico, ", ".join(SERVICOS)))
    categoria, descricao = SERVICOS[servico]
    agora = datetime.now(TZ)
    comp = competencia or agora.date()
    cnpj = PRESTADOR["CNPJ"]

    dps = etree.Element("{%s}DPS" % NS, nsmap={None: NS})
    dps.set("versao", "1.01")
    inf = el(dps, "infDPS")
    inf.set("Id", monta_id(IBGE_TERESINA, cnpj, serie, ndps))

    el(inf, "tpAmb", tp_amb)
    el(inf, "dhEmi", agora.replace(microsecond=0).isoformat())
    el(inf, "verAplic", "nanoclaw-1.0")
    el(inf, "serie", serie)
    el(inf, "nDPS", ndps)
    el(inf, "dCompet", comp.isoformat())
    el(inf, "tpEmit", "1")              # 1=Prestador do serviço
    el(inf, "cLocEmi", IBGE_TERESINA)

    prest = el(inf, "prest")
    el(prest, "CNPJ", cnpj)
    el(prest, "IM", PRESTADOR["IM"])
    reg = el(prest, "regTrib")
    el(reg, "opSimpNac", PRESTADOR["opSimpNac"])
    el(reg, "regEspTrib", PRESTADOR["regEspTrib"])

    toma = el(inf, "toma")
    if len(tomador["doc"]) == 11:
        el(toma, "CPF", tomador["doc"])
    else:
        el(toma, "CNPJ", tomador["doc"])
    el(toma, "xNome", tomador["nome"])
    end = el(toma, "end")
    endnac = el(end, "endNac")
    el(endnac, "cMun", tomador["cMun"])
    el(endnac, "CEP", tomador["CEP"])   # CEP é estrutural — sem ele a prefeitura rejeita
    el(end, "xLgr", tomador["xLgr"])
    el(end, "nro", tomador["nro"])
    el(end, "xBairro", tomador["xBairro"])

    serv = el(inf, "serv")
    loc = el(serv, "locPrest")
    el(loc, "cLocPrestacao", IBGE_TERESINA)
    cserv = el(serv, "cServ")
    el(cserv, "cTribNac", SERVICO["cTribNac"])
    if SERVICO["cTribMun"]:
        el(cserv, "cTribMun", SERVICO["cTribMun"])
    el(cserv, "xDescServ", descricao_servico(descricao))
    el(cserv, "cNBS", NBS_POR_CATEGORIA[categoria])

    valores = el(inf, "valores")
    vserv = el(valores, "vServPrest")
    el(vserv, "vServ", "%.2f" % Decimal(str(valor)))
    trib = el(valores, "trib")
    tmun = el(trib, "tribMun")
    el(tmun, "tribISSQN", ISS["tribISSQN"])
    el(tmun, "tpRetISSQN", ISS["tpRetISSQN"])
    el(tmun, "pAliq", ISS["pAliq"])
    ttot = el(trib, "totTrib")
    el(ttot, "indTotTrib", "0")         # 0=Não informa o total de tributos

    ibscbs = el(inf, "IBSCBS")
    el(ibscbs, "finNFSe", IBSCBS["finNFSe"])
    el(ibscbs, "cIndOp", IBSCBS["cIndOp"])
    el(ibscbs, "indDest", IBSCBS["indDest"])
    v = el(ibscbs, "valores")
    t = el(v, "trib")
    g = el(t, "gIBSCBS")
    el(g, "CST", IBSCBS["CST"])              # obrigatório, vem ANTES do cClassTrib
    el(g, "cClassTrib", IBSCBS["cClassTrib"])

    return dps


# ───────────────────────────── Assinatura (Fase 2b) ──────────────────────────
DS_NS = "http://www.w3.org/2000/09/xmldsig#"


def _rich_x509(sig):
    """KeyInfo COMPLETO: X509Data com SubjectName + IssuerSerial + Certificate.

    Herdado do nfse_emitir.py: o validador Java do DSF/Teresina estoura NPE
    ("obj must not be null") quando o KeyInfo traz só o X509Certificate — ele
    desreferencia SubjectName/IssuerSerial. Descoberto em produção (2026-07-15).
    O endpoint de DPS é do MESMO fornecedor, então mantemos o KeyInfo completo.
    """
    import xmlsec
    ki = xmlsec.template.ensure_key_info(sig)
    x = xmlsec.template.add_x509_data(ki)
    xmlsec.template.x509_data_add_subject_name(x)
    xmlsec.template.x509_data_add_issuer_serial(x)
    xmlsec.template.x509_data_add_certificate(x)


def assina(dps, pfx_path, pfx_password, inner_tag="infDPS"):
    """Assina a DPS (ou o pedido de evento) no padrão da seção 4 do guia DSF V7.

    - <Signature> dentro da raiz <DPS>, IRMÃ de <infDPS> (enveloped);
    - Reference URI="#<Id do infDPS>";
    - transforms: enveloped-signature + C14N inclusiva;
    - SignatureMethod rsa-sha1, DigestMethod sha1 (NÃO é SHA-256);
    - SEM prefixo de namespace (ns=None) — a regra E1228 rejeita prefixo.
    """
    import xmlsec

    inf = dps.find("{%s}%s" % (NS, inner_tag))
    if inf is None:
        raise ValueError("documento sem <%s>" % inner_tag)
    inf_id = inf.get("Id")
    if not inf_id:
        raise ValueError("%s sem atributo Id" % inner_tag)

    # ns=None => <Signature xmlns="...">, sem prefixo. NUNCA passar ns="ds".
    sig = xmlsec.template.create(
        dps, xmlsec.constants.TransformInclC14N, xmlsec.constants.TransformRsaSha1)
    ref = xmlsec.template.add_reference(
        sig, xmlsec.constants.TransformSha1, uri="#" + inf_id)
    xmlsec.template.add_transform(ref, xmlsec.constants.TransformEnveloped)
    xmlsec.template.add_transform(ref, xmlsec.constants.TransformInclC14N)
    _rich_x509(sig)
    dps.append(sig)                      # irmã de infDPS, dentro da raiz

    xmlsec.tree.add_ids(dps, ["Id"])
    ctx = xmlsec.SignatureContext()
    ctx.key = xmlsec.Key.from_file(
        pfx_path, xmlsec.constants.KeyDataFormatPkcs12, pfx_password)
    ctx.sign(sig)

    # base64 multi-linha quebra validadores rígidos; fora do SignedInfo é seguro.
    for tag in ("SignatureValue", "X509Certificate"):
        for el in sig.iter("{%s}%s" % (DS_NS, tag)):
            if el.text:
                el.text = "".join(el.text.split())
    return dps


def verifica_assinatura(dps, pfx_path, pfx_password):
    """Confere a própria assinatura — prova que o digest fecha com o conteúdo."""
    import xmlsec
    sig = dps.find("{%s}Signature" % DS_NS)
    if sig is None:
        return False, "nenhuma <Signature> na raiz DPS"
    xmlsec.tree.add_ids(dps, ["Id"])
    ctx = xmlsec.SignatureContext()
    ctx.key = xmlsec.Key.from_file(
        pfx_path, xmlsec.constants.KeyDataFormatPkcs12, pfx_password)
    try:
        ctx.verify(sig)
        return True, "assinatura confere"
    except Exception as exc:
        return False, "%s: %s" % (type(exc).__name__, exc)



# ─────────────────────── Cancelamento (evento e101101) ───────────────────────
# Motivos aceitos pelo XSD (TSCodJustCanc): 1=Erro na emissão,
# 2=Serviço não prestado, 9=Outros.
MOTIVOS_CANCELAMENTO = {"1": "Erro na Emissão", "2": "Serviço não Prestado", "9": "Outros"}


def monta_cancelamento(chave_acesso, cmotivo="1", xmotivo=None, tp_amb="2"):
    """Monta o pedidoRegistroEvento de CANCELAMENTO (e101101) de uma NFS-e.

    O Id é 'PRE' + 56 dígitos (TSIdPedRegEvt): os 50 dígitos da chave de acesso
    seguidos do código do evento (101101).
    """
    if cmotivo not in MOTIVOS_CANCELAMENTO:
        raise ValueError("cMotivo deve ser 1, 2 ou 9 — recebido %r" % cmotivo)
    digitos = "".join(c for c in chave_acesso if c.isdigit())
    if len(digitos) != 50:
        raise ValueError("chave de acesso deve ter 50 dígitos, tem %d" % len(digitos))

    ped = etree.Element("{%s}pedRegEvento" % NS, nsmap={None: NS})
    ped.set("versao", "1.01")
    inf = el(ped, "infPedReg")
    inf.set("Id", "PRE" + digitos + "101101")

    el(inf, "tpAmb", tp_amb)
    el(inf, "verAplic", "nanoclaw-1.0")
    el(inf, "dhEvento", datetime.now(TZ).replace(microsecond=0).isoformat())
    el(inf, "CNPJAutor", PRESTADOR["CNPJ"])      # CNPJAutor XOR CPFAutor
    el(inf, "chNFSe", digitos)
    ev = el(inf, "e101101")
    el(ev, "xDesc", "Cancelamento de NFS-e")     # texto fixo exigido pelo enum
    el(ev, "cMotivo", cmotivo)
    el(ev, "xMotivo", xmotivo or MOTIVOS_CANCELAMENTO[cmotivo])
    return ped


def valida_cancelamento(doc, xsd_dir):
    """Valida o pedido contra pedRegEvento_v1.01.xsd."""
    xsd = os.path.join(xsd_dir, "pedRegEvento_v1.01.xsd")
    if not os.path.exists(xsd):
        return None
    schema = etree.XMLSchema(etree.parse(xsd))
    return schema.validate(doc), list(schema.error_log)


# Defeito do XSD oficial v1.01: TSSerieDPS tem pattern "^0{0,4}\\d{1,5}$".
# Em XML Schema o pattern já é ancorado e ^/$ são CARACTERES LITERAIS — então
# o tipo só aceitaria a string literal "^00001$" e nenhuma série real valida
# (o próprio XML modelo publicado pela SEMF falha nesse campo). Corrigimos o
# pattern em memória, sem tocar no arquivo baixado.
# TODO(SEMF): reportar. Reavaliar quando sair uma v1.02.
SERIE_PATTERN_BUG = "^0{0,4}\\d{1,5}$"
SERIE_PATTERN_FIX = "0{0,4}\\d{1,5}"


def _carrega_schema(xsd_dir, corrigir_bug=True):
    """Carrega o XSD resolvendo os includes a partir de xsd_dir."""
    xsd = os.path.join(xsd_dir, "DPS_v1.01.xsd")
    if not os.path.exists(xsd):
        return None
    if not corrigir_bug:
        return etree.XMLSchema(etree.parse(xsd))
    simples = os.path.join(xsd_dir, "tiposSimples_v1.01.xsd")
    texto = open(simples, encoding="utf-8").read()
    if SERIE_PATTERN_BUG not in texto:
        return etree.XMLSchema(etree.parse(xsd))
    # reescreve só o tiposSimples num diretório temporário com os demais linkados
    import shutil, tempfile
    tmp = tempfile.mkdtemp(prefix="nfse-xsd-")
    for nome in os.listdir(xsd_dir):
        shutil.copy(os.path.join(xsd_dir, nome), os.path.join(tmp, nome))
    open(os.path.join(tmp, "tiposSimples_v1.01.xsd"), "w", encoding="utf-8").write(
        texto.replace(SERIE_PATTERN_BUG, SERIE_PATTERN_FIX))
    return etree.XMLSchema(etree.parse(os.path.join(tmp, "DPS_v1.01.xsd")))


def valida(doc, xsd_dir, corrigir_bug=True):
    schema = _carrega_schema(xsd_dir, corrigir_bug)
    if schema is None:
        print("XSD não encontrado em %s" % xsd_dir, file=sys.stderr)
        print("Baixe nfse-esquemas_xsd-v1-01-*.zip do gov.br e aponte --xsd / NFSE_XSD_DIR.",
              file=sys.stderr)
        return None
    ok = schema.validate(doc)
    return ok, list(schema.error_log)


# Paciente fictício — nenhum dado real de paciente neste arquivo.
TOMADOR_FICTICIO = {
    "doc": "52998224725",            # CPF fictício com DV válido
    "nome": "MARIA DA SILVA SANTOS",
    "cMun": IBGE_TERESINA,
    "CEP": "64000000",
    "xLgr": "RUA DAS ACACIAS",
    "nro": "123",
    "xBairro": "CENTRO",
}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out")
    ap.add_argument("--xsd", default=os.environ.get("NFSE_XSD_DIR", ""))
    ap.add_argument("--valor", default="400.00")
    ap.add_argument("--servico", default="consulta", choices=sorted(SERVICOS))
    ap.add_argument("--xsd-cru", action="store_true",
                    help="valida sem corrigir o defeito do TSSerieDPS (mostra o bug)")
    ap.add_argument("--assinar", action="store_true", help="assina com o A1 (precisa xmlsec)")
    ap.add_argument("--pfx", default=os.environ.get("NFSE_CERT_PATH", ""))
    ap.add_argument("--pfx-senha", default=os.environ.get("NFSE_CERT_PASSWORD", ""))
    args = ap.parse_args()

    dps = monta_dps(TOMADOR_FICTICIO, args.valor, servico=args.servico)

    if args.assinar:
        if not args.pfx:
            print("--assinar precisa de --pfx (ou NFSE_CERT_PATH)", file=sys.stderr)
            return 2
        assina(dps, args.pfx, args.pfx_senha)
        ok_sig, msg = verifica_assinatura(dps, args.pfx, args.pfx_senha)
        print(("✅ " if ok_sig else "❌ ") + "assinatura: " + msg)

    xml = etree.tostring(dps, pretty_print=True, xml_declaration=True, encoding="UTF-8")

    if args.out:
        open(args.out, "wb").write(xml)
        print("XML salvo em %s (%d bytes)" % (args.out, len(xml)))

    if not args.xsd:
        print(xml.decode("utf-8"))
        print("Sem --xsd/NFSE_XSD_DIR: validação pulada.", file=sys.stderr)
        return 0

    res = valida(dps, args.xsd, corrigir_bug=not args.xsd_cru)
    if res is None:
        return 2
    ok, erros = res
    if ok:
        print("✅ DPS VÁLIDA contra DPS_v1.01.xsd")
        return 0
    print("❌ DPS inválida — %d erro(s):" % len(erros))
    for e in erros:
        print("   linha %s: %s" % (e.line, e.message))
    return 1


if __name__ == "__main__":
    sys.exit(main())
