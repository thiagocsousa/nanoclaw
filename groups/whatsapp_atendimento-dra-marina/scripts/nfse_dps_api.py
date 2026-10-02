#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Cliente HTTP da API de DPS (NFS-e Padrão Nacional / Teresina). **Fase 3** de
docs/NFSE-DPS-MIGRACAO.md.

Endpoints (guia DSF V7):
  POST /notafiscal-ws/nfse                      -> DPS vira NFS-e (síncrono)
  GET  /notafiscal-ws/nfse/dps/{id}             -> chave de acesso a partir da DPS
  GET  /notafiscal-ws/nfse/{chaveAcesso}        -> consulta a NFS-e
  POST /notafiscal-ws/nfse/{chave}/eventos      -> evento (ex.: cancelamento)

Autenticação: mTLS com o A1. O certificado vem de **NFSE_CERT_B64** (base64 do
.pfx, mesmo padrão do nfse_emitir_pipeline.py) + NFSE_CERT_PASSWORD; aceita
também NFSE_CERT_PATH como alternativa. O .pfx é convertido para PEM **em
memória** (memfd) e passado ao requests via /proc/self/fd/N — diferente do
pipeline ABRASF, que grava um .pfx temporário em disco, aqui a chave nunca
toca o sistema de arquivos.

⚠️ ANTI-DUPLICATA: a emissão é síncrona, mas se a resposta se perder (timeout,
queda) a nota pode ter sido gerada do mesmo jeito. NUNCA reenviar uma DPS sem
antes chamar consulta_por_dps(idDps): se já existe NFS-e, reenviar gera nota
duplicada com efeito fiscal real.
"""
import gzip
import json
import os
import sys
import base64

import requests

AMBIENTES = {
    "homologacao": os.environ.get(
        "NFSE_DPS_URL_HOMOLOGACAO", "https://nfse2-the.dsfweb.com.br"),
    "producao": os.environ.get(
        "NFSE_DPS_URL_PRODUCAO", "https://nfseapi.teresina.pi.gov.br"),
}

# A primeira chamada do dia pode levar ~25s (cold start observado em 2026-10-02)
# e a 1ª emissão em homologação estourou 60s de leitura. Timeout curto faz a
# emissão falhar sozinha — e, pior, deixa a dúvida de se a nota saiu ou não.
TIMEOUT_CONSULTA = (10, 60)
TIMEOUT_EMISSAO = (10, int(os.environ.get("NFSE_DPS_TIMEOUT", "180")))
TIMEOUT = TIMEOUT_CONSULTA   # compatibilidade


class DpsError(RuntimeError):
    def __init__(self, status, erros, bruto=""):
        self.status = status
        self.erros = erros or []
        self.bruto = bruto
        if self.erros:
            txt = "; ".join("%s: %s" % (e.get("codigo"), e.get("mensagem")) for e in self.erros)
        else:
            txt = bruto[:300] or "(sem corpo)"
        super().__init__("HTTP %s — %s" % (status, txt))


def _pem_em_memoria(pfx_bytes, senha):
    """Converte o .pfx (bytes) para PEM (chave + cert + cadeia) num memfd e
    devolve o caminho /proc/self/fd/N. Nada toca o disco. O fd fica aberto
    enquanto o processo viver — é intencional, o requests reabre o caminho a
    cada request.
    """
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.serialization import pkcs12

    chave, cert, cadeia = pkcs12.load_key_and_certificates(
        pfx_bytes, (senha or "").encode() or None)
    if chave is None or cert is None:
        raise RuntimeError("pfx sem chave privada ou sem certificado")

    pem = chave.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    )
    pem += cert.public_bytes(serialization.Encoding.PEM)
    for extra in (cadeia or []):
        pem += extra.public_bytes(serialization.Encoding.PEM)

    fd = os.memfd_create("nfse-cert", 0)
    os.write(fd, pem)
    os.lseek(fd, 0, os.SEEK_SET)
    return "/proc/self/fd/%d" % fd


_CERT_CACHE = {}


def _cert(pfx_path=None, senha=None):
    """Resolve o A1: NFSE_CERT_B64 (preferido) ou NFSE_CERT_PATH. Cacheia o
    memfd — não faz sentido reconverter a cada chamada."""
    senha = senha if senha is not None else os.environ.get("NFSE_CERT_PASSWORD", "")
    chave_cache = (pfx_path or "", bool(senha))
    if chave_cache in _CERT_CACHE:
        return _CERT_CACHE[chave_cache]

    if pfx_path:
        pfx_bytes = open(pfx_path, "rb").read()
    else:
        b64 = os.environ.get("NFSE_CERT_B64", "")
        if b64:
            pfx_bytes = base64.b64decode(b64)
        else:
            caminho = os.environ.get("NFSE_CERT_PATH", "")
            if not caminho:
                raise RuntimeError(
                    "defina NFSE_CERT_B64 (base64 do .pfx) ou NFSE_CERT_PATH")
            pfx_bytes = open(caminho, "rb").read()

    _CERT_CACHE[chave_cache] = _pem_em_memoria(pfx_bytes, senha)
    return _CERT_CACHE[chave_cache]


def gzip_b64(xml_bytes):
    """A API recebe o XML compactado em gzip e codificado em base64."""
    return base64.b64encode(gzip.compress(xml_bytes)).decode("ascii")


def ungzip_b64(texto):
    return gzip.decompress(base64.b64decode(texto)).decode("utf-8")


def _resposta(r):
    try:
        corpo = r.json()
    except ValueError:
        raise DpsError(r.status_code, None, r.text)
    if r.status_code >= 400 or corpo.get("erros"):
        raise DpsError(r.status_code, corpo.get("erros"), r.text)
    return corpo


def _get(caminho, ambiente, cert):
    url = AMBIENTES[ambiente] + caminho
    return _resposta(requests.get(url, cert=cert, timeout=TIMEOUT_CONSULTA))


def enviar_dps(xml_bytes, ambiente="homologacao", pfx=None, senha=None):
    """POST /notafiscal-ws/nfse. Devolve o JSON com chaveAcesso e a NFS-e."""
    cert = _cert(pfx, senha)
    url = AMBIENTES[ambiente] + "/notafiscal-ws/nfse"
    r = requests.post(url, json={"dpsXmlGZipB64": gzip_b64(xml_bytes)},
                      cert=cert, timeout=TIMEOUT_EMISSAO)
    return _resposta(r)


def consulta_por_dps(id_dps, ambiente="homologacao", pfx=None, senha=None):
    """GET /notafiscal-ws/nfse/dps/{id}. Devolve None em 404 (nenhuma NFS-e).

    É a trava anti-duplicata: chamar ANTES de reenviar qualquer DPS.
    """
    try:
        return _get("/notafiscal-ws/nfse/dps/" + id_dps, ambiente, _cert(pfx, senha))
    except DpsError as e:
        if e.status == 404:
            return None
        raise


def consulta_nfse(chave, ambiente="homologacao", pfx=None, senha=None):
    """GET /notafiscal-ws/nfse/{chaveAcesso}."""
    return _get("/notafiscal-ws/nfse/" + chave, ambiente, _cert(pfx, senha))


def emitir_com_protecao(xml_bytes, id_dps, ambiente="homologacao", pfx=None, senha=None):
    """Emite checando antes se aquela DPS já virou nota. Use SEMPRE isto em vez
    de enviar_dps() direto quando houver chance de retry."""
    ja = consulta_por_dps(id_dps, ambiente, pfx, senha)
    if ja:
        return {"reaproveitada": True, **ja}
    return {"reaproveitada": False, **enviar_dps(xml_bytes, ambiente, pfx, senha)}


def main():
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("acao", choices=["enviar", "consulta-dps", "consulta-nfse"])
    ap.add_argument("--ambiente", default="homologacao", choices=sorted(AMBIENTES))
    ap.add_argument("--xml", help="arquivo com a DPS assinada (ação enviar)")
    ap.add_argument("--id", help="idDps ou chave de acesso (ações de consulta)")
    ap.add_argument("--pfx", default="", help="opcional; o padrão é NFSE_CERT_B64")
    ap.add_argument("--senha", default=None)
    a = ap.parse_args()

    try:
        if a.acao == "enviar":
            xml = open(a.xml, "rb").read()
            print("enviando %d bytes de XML (%d em gzip+b64) para %s"
                  % (len(xml), len(gzip_b64(xml)), a.ambiente))
            r = emitir_com_protecao(xml, a.id or "", a.ambiente, a.pfx or None, a.senha) \
                if a.id else enviar_dps(xml, a.ambiente, a.pfx or None, a.senha)
            print(json.dumps({k: v for k, v in r.items() if k != "nfseXmlGZipB64"},
                             ensure_ascii=False, indent=2))
            if r.get("nfseXmlGZipB64"):
                print("--- NFS-e (primeiras linhas) ---")
                print("\n".join(ungzip_b64(r["nfseXmlGZipB64"]).splitlines()[:15]))
        elif a.acao == "consulta-dps":
            r = consulta_por_dps(a.id, a.ambiente, a.pfx or None, a.senha)
            print(json.dumps(r, ensure_ascii=False, indent=2) if r else "404 — nenhuma NFS-e para essa DPS")
        else:
            r = consulta_nfse(a.id, a.ambiente, a.pfx or None, a.senha)
            print(json.dumps({k: v for k, v in r.items() if k != "nfseXmlGZipB64"},
                             ensure_ascii=False, indent=2))
    except DpsError as e:
        print("❌ %s" % e, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
