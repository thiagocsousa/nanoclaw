#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Emite as NFS-e SELECIONADAS (aprovação do atendimento) e agenda a entrega do PDF
no WhatsApp de cada paciente.

Uso: python3 nfse_emitir_pipeline.py "1,3,5" | "todos"

Fluxo: lê pending_nfse.json → emite o subconjunto em lote (produção) → baixa o
DANFSE (PDF) → marca receita_id como emitida → avança o número do RPS → agenda
(escalonado) o envio do PDF pro paciente via send_nota.py.

Segredos via env: NFSE_CERT_B64 (certificado A1 em base64) + NFSE_CERT_PASSWORD.
"""
import base64
import json
import os
import random
import re
import string
import sys
import tempfile
import time
import unicodedata
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import nfse_emitir as e  # noqa: E402

GROUP = os.environ.get("NANOCLAW_GROUP_DIR", "/workspace/group")
PENDING_FILE = Path(GROUP) / "pending_nfse.json"
EMITIDAS_FILE = Path(GROUP) / "nfse_emitidas.json"
RPS_STATE = Path(GROUP) / "nfse_rps_state.json"
ATTACH_DIR = Path(GROUP) / "attachments"
ENTREGAS_DIR = Path(GROUP) / "entregas"
IPC_TASKS_DIR = Path("/workspace/ipc/tasks")
TZ = timezone(timedelta(hours=-3))   # America/Fortaleza
AMBIENTE = os.environ.get("NFSE_AMBIENTE", "producao")

# Backend de emissão. "abrasf" = SOAP ABRASF 2.03 (o que roda hoje em produção).
# "dps" = REST/Padrão Nacional (ver docs/NFSE-DPS-MIGRACAO.md). O padrão é
# abrasf de propósito: enquanto não virar a chave, NADA muda no fluxo real.
# Dá para voltar atrás numa variável de ambiente, sem deploy de código.
NFSE_MODO = os.environ.get("NFSE_MODO", "abrasf").lower()
DPS_STATE = Path(GROUP) / "nfse_dps_state.json"


def rand_id(n=6):
    return "".join(random.choices(string.ascii_lowercase + string.digits, k=n))


def slug(nome):
    s = unicodedata.normalize("NFKD", nome or "").encode("ascii", "ignore").decode()
    return re.sub(r"[^A-Za-z0-9]+", "_", s).strip("_")[:45] or "tomador"


def normalize_phone(tel):
    d = re.sub(r"\D", "", tel or "")
    if not d:
        return None
    if d.startswith("55") and len(d) >= 12:
        return d
    if len(d) in (10, 11):           # DDD + número
        return "55" + d
    return d


def cert_path():
    b64 = os.environ.get("NFSE_CERT_B64")
    if not b64:
        raise SystemExit("NFSE_CERT_B64 não definido (certificado A1 em base64).")
    fd, path = tempfile.mkstemp(suffix=".pfx")
    os.write(fd, base64.b64decode(b64))
    os.close(fd)
    return path


def parse_selecao(sel, itens):
    sel = (sel or "").strip().lower()
    if sel in ("todos", "tudo", "all", "aprovar", "aprovado"):
        return list(itens)
    idxs = set()
    for tok in re.split(r"[,\s]+", sel):
        if not tok:
            continue
        if "-" in tok:
            a, b = tok.split("-", 1)
            if a.isdigit() and b.isdigit():
                idxs.update(range(int(a), int(b) + 1))
        elif tok.isdigit():
            idxs.add(int(tok))
    return [x for x in itens if x["n"] in idxs]


def emitter_tomador(tom):
    """collector tomador {nome,doc,tipo,endereco} → emitter tomador {nome,cpf|cnpj,endereco}."""
    doc = tom.get("doc")
    pj = tom.get("tipo") == "PJ" or (doc and len(doc) == 14)
    out = {"nome": tom.get("nome"), "endereco": tom.get("endereco") or {}}
    out["cnpj" if pj else "cpf"] = doc
    return out


def load_next_rps():
    if RPS_STATE.exists():
        return int(json.loads(RPS_STATE.read_text()).get("next_rps", 1))
    return int(os.environ.get("NFSE_RPS_INICIAL", "1"))


def write_ipc_task(data):
    IPC_TASKS_DIR.mkdir(parents=True, exist_ok=True)
    fp = IPC_TASKS_DIR / f"{int(time.time()*1000)}-{rand_id()}.json"
    tmp = Path(str(fp) + ".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2))
    tmp.rename(fp)
    time.sleep(0.05)



def load_next_ndps():
    """Sequência de nDPS (independente da numeração de RPS do ABRASF)."""
    try:
        return int(json.loads(DPS_STATE.read_text())["next_ndps"])
    except Exception:
        return int(os.environ.get("NFSE_DPS_INICIAL", "1"))


def emitir_via_dps(escolhidos, pfx, pwd, chave_match):
    """Emite UMA DPS por item (o padrão nacional não tem lote) e devolve um
    resultado no mesmo formato do ABRASF, para o resto do pipeline não mudar.

    Diferenças que o chamador precisa saber:
      • não há protocolo de lote — cada nota é independente;
      • não há codigo_verificacao, então o DANFSE atual não funciona
        (ver "Fase 5 bloqueada" em docs/NFSE-DPS-MIGRACAO.md);
      • falha de um item NÃO derruba os outros.

    `chave_match` é a lista de chaves que o main() usa para casar item ↔ nota
    (a sequência de RPS). O nDPS é uma sequência SEPARADA, própria da DPS —
    devolver o nDPS aqui faria o main() não encontrar a nota e marcar como
    falha uma emissão que deu certo.
    """
    import nfse_dps as b
    import nfse_dps_api as api
    from lxml import etree

    ambiente_dps = "producao" if AMBIENTE == "producao" else "homologacao"
    tp_amb = "1" if ambiente_dps == "producao" else "2"
    next_ndps = load_next_ndps()
    notas, mensagens, manuais = [], [], []

    for i, x in enumerate(escolhidos):
        ndps = next_ndps + i
        # Lê o formato do COLETOR ({nome, doc, tipo, endereco{...}, telefone}).
        # Atenção: o endereço é ANINHADO em "endereco" — ler no topo devolve
        # vazio e a nota sai sem CEP/logradouro.
        tom = x["tomador"]
        end = tom.get("endereco") or {}
        tomador = {
            "doc": re.sub(r"\D", "", tom.get("doc") or ""),
            "nome": tom.get("nome") or "",
            "cMun": str(end.get("codigo_municipio") or b.IBGE_TERESINA),
            "CEP": re.sub(r"\D", "", end.get("cep") or ""),
            "xLgr": end.get("logradouro") or "",
            "nro": end.get("numero") or "S/N",
            "xBairro": end.get("bairro") or "",
        }
        if len(tomador["doc"]) == 14:
            # Tomador PJ: a DPS não atende (ver trava no nfse_dps.py). NÃO marca
            # como emitida — o item reaparece amanhã e sai no resumo para a
            # recepção emitir à mão.
            manuais.append((str(x["receita_id"]), x["paciente"], x["servico"], x["valor"]))
            continue
        faltando = [k for k in ("doc", "nome", "CEP", "xLgr", "xBairro") if not tomador[k]]
        if faltando:
            # Não envia cadastro incompleto: a prefeitura rejeita com mensagem
            # enganosa (o histórico do "L999 = CEP faltando").
            mensagens.append("%s: cadastro incompleto, faltou %s"
                             % (x["paciente"], ", ".join(faltando)))
            continue
        dps = b.monta_dps(tomador, str(x["valor"]), servico=x["servico"],
                          ndps=ndps, tp_amb=tp_amb)
        id_dps = dps.find("{%s}infDPS" % b.NS).get("Id")
        b.assina(dps, pfx, pwd)
        xml = etree.tostring(dps, xml_declaration=True, encoding="UTF-8")
        try:
            # emitir_com_protecao consulta a DPS antes: se a resposta de um envio
            # anterior se perdeu, reaproveita em vez de duplicar a nota.
            r = api.emitir_com_protecao(xml, id_dps, ambiente_dps)
        except api.DpsError as ex:
            mensagens.append("%s: %s" % (x["paciente"], ex))
            continue
        chave = r.get("chaveAcesso", "")
        xml_nfse = r.get("nfseXmlGZipB64")
        if not xml_nfse and chave:
            # Caminho "reaproveitada": a consulta por idDps devolve só a chave,
            # sem o XML. Busca a nota para conseguir o número de verdade, em vez
            # de cair no fallback e mostrar um número que não existe.
            try:
                xml_nfse = api.consulta_nfse(chave, ambiente_dps).get("nfseXmlGZipB64")
            except api.DpsError:
                xml_nfse = None
        numero = ""
        if xml_nfse:
            m = re.search(r"<nNFSe>(\d+)</nNFSe>", api.ungzip_b64(xml_nfse))
            numero = m.group(1) if m else ""
        notas.append({
            "numero": numero or chave[-12:],
            "codigo_verificacao": None,     # a DPS não devolve — DANFSE pendente
            "chave_acesso": chave,
            "rps_numero": chave_match[i],   # chave de casamento do main(), NÃO o nDPS
            "ndps": ndps,
        })

    DPS_STATE.write_text(json.dumps({"next_ndps": next_ndps + len(escolhidos)}))

    return {"protocolo": "(DPS: sem lote)", "notas": notas,
            "mensagens": mensagens, "manuais": manuais}


def main():
    sel = sys.argv[1] if len(sys.argv) > 1 else "todos"
    if not PENDING_FILE.exists():
        print("Erro: pending_nfse.json não encontrado (rode a coleta primeiro).", file=sys.stderr)
        sys.exit(1)
    pending = json.loads(PENDING_FILE.read_text())
    escolhidos = parse_selecao(sel, pending["itens"])
    if not escolhidos:
        print("Seleção vazia — nada emitido. Responda com os números (ex: 1,3,5) ou 'todos'.")
        return

    pfx = cert_path()
    pwd = os.environ.get("NFSE_CERT_PASSWORD")
    next_rps = load_next_rps()
    itens = [{"servico": {"servico": x["servico"], "valor": str(x["valor"])},
              "tomador": emitter_tomador(x["tomador"]), "rps_numero": next_rps + i}
             for i, x in enumerate(escolhidos)]

    if NFSE_MODO == "dps":
        parsed = emitir_via_dps(escolhidos, pfx, pwd,
                                [next_rps + i for i in range(len(escolhidos))])
    elif NFSE_MODO == "abrasf":
        parsed, _ = e.emitir(itens, 1, AMBIENTE, pfx, pwd)
        RPS_STATE.write_text(json.dumps({"next_rps": next_rps + len(itens)}))
    else:
        raise SystemExit("NFSE_MODO inválido: %r (use 'abrasf' ou 'dps')" % NFSE_MODO)

    ATTACH_DIR.mkdir(parents=True, exist_ok=True)
    ENTREGAS_DIR.mkdir(parents=True, exist_ok=True)
    emitidas = set(map(str, json.loads(EMITIDAS_FILE.read_text()))) if EMITIDAS_FILE.exists() else set()
    chat_jid = os.environ.get("NANOCLAW_CHAT_JID", "")
    group_folder = os.environ.get("NANOCLAW_GROUP_FOLDER", "whatsapp_atendimento-dra-marina")

    ok, agendados, falhas, pdf_pendentes = [], 0, [], []
    manuais_ids = {m[0] for m in parsed.get("manuais", [])}
    now = datetime.now(TZ)
    accum = timedelta(0)
    # mapeia cada item enviado → nota emitida PELO NÚMERO DO RPS (robusto a falha
    # parcial do lote). Fallback por ordem só se TODAS saíram (contagem bate).
    by_rps = {str(n["rps_numero"]): n for n in parsed["notas"] if n.get("rps_numero")}
    for i, x in enumerate(escolhidos):
        n = by_rps.get(str(next_rps + i))
        if n is None and len(parsed["notas"]) == len(escolhidos):
            n = parsed["notas"][i]
        if not n or not n.get("numero"):
            # Não marca emitida → reaparece amanhã, nos dois casos.
            # Item roteado para emissão manual não é FALHA: já aparece na sua
            # própria seção do resumo, e listar duas vezes confunde quem lê.
            if str(x["receita_id"]) not in manuais_ids:
                falhas.append(x["paciente"])
            continue
        emitidas.add(str(x["receita_id"]))
        pdf_name = f"nota_{n['numero']}_{slug(x['tomador'].get('nome'))}.pdf"
        pdf_path = ATTACH_DIR / pdf_name
        chave = ""
        if not n.get("codigo_verificacao"):
            # Modo DPS: a emissão não devolve código de verificação, e o DANFSE
            # do portal municipal exige esse código. Até 06/10/2026 a saída era
            # o Playwright no portal da prefeitura — que saiu do ar por mais de
            # um dia em 05/10 e a SEMF não soube dizer por quê.
            #
            # Agora entregamos o LINK da consulta pública NACIONAL com a chave
            # de acesso. Some o navegador, o login do portal e o captcha, e quem
            # acessa é o paciente. Conferido que a NFS-e de Teresina está
            # publicada no nacional (`GET sefinnacional/nfse/{chave}` = 200).
            #
            # Decisão do Thiago em 06/10/2026: "melhor do que depender de site
            # de prefeitura e recaptcha".
            chave = n.get("chave_acesso") or ""
            pdf_path = None
            if not chave:
                # Sem chave não há como o paciente achar a nota. Não inventa
                # link: entra como pendência para a recepção resolver à mão.
                pdf_pendentes.append((x["paciente"], n["numero"]))
        else:
            try:
                e.baixar_danfse(n["numero"], n["codigo_verificacao"], AMBIENTE, destino=str(pdf_path))
            except Exception as ex:
                print(f"  aviso: PDF da nota {n['numero']} falhou: {ex}", file=sys.stderr)
                pdf_path = None
        tel = normalize_phone(x["tomador"].get("telefone"))
        if tel and (pdf_path or chave):
            # grava a entrega e agenda o envio escalonado (60-180s entre cada)
            eid = f"{n['numero']}-{rand_id()}"
            (ENTREGAS_DIR / f"{eid}.json").write_text(json.dumps({
                "telefone": tel, "paciente": x["paciente"],
                # Um dos dois, nunca os dois: o send_nota.py prefere o PDF e cai
                # no link quando não há anexo.
                "pdf": f"/workspace/group/attachments/{pdf_name}" if pdf_path else None,
                "chave": chave or None,
                "chat_jid_paciente": f"{tel}@s.whatsapp.net",
                "group_folder": group_folder,
            }, ensure_ascii=False))
            accum += timedelta(seconds=random.randint(60, 180)) if agendados else timedelta(0)
            send_at = (now + accum).strftime("%Y-%m-%dT%H:%M:%S")
            write_ipc_task({
                "type": "schedule_task",
                "taskId": f"nfse-entrega-{int(time.time()*1000)}-{rand_id()}",
                "prompt": "<internal>Entrega de NFS-e agendada.</internal>",
                "script": f"python3 /workspace/group/scripts/send_nota.py {eid}",
                "schedule_type": "once",
                "schedule_value": send_at,
                "context_mode": "isolated",
                "targetJid": chat_jid,
                "createdBy": group_folder,
                "timestamp": datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%S.000Z"),
            })
            agendados += 1
        ok.append((x["paciente"], x["servico"], n["numero"], bool(tel)))

    EMITIDAS_FILE.write_text(json.dumps(sorted(emitidas), ensure_ascii=False))

    # A fila do DANFSE pelo portal municipal saiu daqui em 06/10/2026, quando a
    # entrega passou a ser o link da consulta nacional. O
    # `nfse_danfse_pipeline.py` e o `nfse_danfse_portal.py` continuam no repo:
    # são o único caminho conhecido para o PDF OFICIAL, se um dia a prefeitura
    # voltar a servir o login ou a SEMF implementar o DANFSE nacional (hoje 501).
    # Nada mais os alimenta, então o cron `marina-danfse` roda em fila vazia.

    lines = [f"✅ *{len(ok)}* nota(s) emitida(s) — protocolo {parsed.get('protocolo')}:"]
    for pac, serv, num, temtel in ok:
        entrega = "→ envio agendado" if temtel else "⚠️ sem telefone (não enviada)"
        lines.append(f"• NFSe *{num}* — {pac} ({serv}) {entrega}")
    if parsed.get("manuais"):
        lines.append("\n🧾 *Emitir À MÃO* (tomador CNPJ — a automação não atende):")
        for _rid, pac, serv, val in parsed["manuais"]:
            lines.append(f"• {pac} ({serv}) — R$ {val}")
        lines.append("_Continuam na lista até serem emitidas._")
    if pdf_pendentes:
        lines.append(f"\n⚠️ *Sem chave de acesso* ({len(pdf_pendentes)}) — o paciente NÃO recebeu:")
        for pac, num in pdf_pendentes:
            lines.append(f"• NFSe *{num}* — {pac}")
        lines.append("_A nota saiu, mas não consegui o link. Enviar à mão._")
    if falhas:
        lines.append(f"\n❌ Falharam: {', '.join(falhas)}")
    if parsed.get("mensagens"):
        lines.append(f"\nMensagens do servidor: {parsed['mensagens']}")
    print("\n".join(lines))


if __name__ == "__main__":
    main()
