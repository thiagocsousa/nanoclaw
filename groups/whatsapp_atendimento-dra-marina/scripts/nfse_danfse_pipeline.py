#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Baixa os DANFSE pendentes e agenda a entrega ao paciente. Roda SEPARADO da
emissão (ver docs/NFSE-DPS-MIGRACAO.md).

## Por que separado

Medido em 2026-10-02: o download custa ~20 s por nota (Chromium + portal). Um
lote de 8 notas passaria dos 180 s do pré-check do agent-runner e **derrubaria
a emissão** — que é rápida, já funciona, e não pode depender de um navegador
lento. Então a emissão só ENFILEIRA o que falta, e este script esvazia a fila
depois, no seu próprio tempo.

    emissão      → nota emitida + enfileira o número
    este script  → baixa o PDF → agenda send_nota.py → paciente

## Idempotente e com desistência

Cada tentativa é contada. Nota que não baixa continua na fila e é tentada de
novo na próxima rodada — assim falha transitória do portal se resolve sozinha.
Depois de MAX_TENTATIVAS a nota sai da fila com aviso: nota CANCELADA, por
exemplo, nunca vai ter DANFSE, e insistir para sempre só poluiria o log.

Nunca reenvia PDF já entregue: o item sai da fila assim que a entrega é
agendada.

Uso:
  python3 nfse_danfse_pipeline.py            # processa a fila
  python3 nfse_danfse_pipeline.py --listar   # só mostra a fila
"""
import json
import os
import random
import string
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

GROUP = Path(os.environ.get("NANOCLAW_GROUP_DIR", "/workspace/group"))
FILA = GROUP / "nfse_danfse_pendentes.json"
ATTACH_DIR = GROUP / "attachments"
ENTREGAS_DIR = GROUP / "entregas"
IPC_TASKS_DIR = Path("/workspace/ipc/tasks")
TZ = timezone(timedelta(hours=-3))   # America/Fortaleza

MAX_TENTATIVAS = int(os.environ.get("NFSE_DANFSE_MAX_TENTATIVAS", "5"))
# Teto por rodada: o pré-check do agent-runner aborta em 180 s e cada nota
# custa ~20 s. 6 notas (~120 s + login) deixa margem. O que sobrar fica na fila
# e sai na próxima rodada — melhor devagar do que derrubar a task.
MAX_POR_RODADA = int(os.environ.get("NFSE_DANFSE_MAX_RODADA", "6"))


def rand_id(n=6):
    return "".join(random.choices(string.ascii_lowercase + string.digits, k=n))


def carrega_fila():
    try:
        dados = json.loads(FILA.read_text(encoding="utf-8"))
        return dados if isinstance(dados, list) else []
    except (OSError, json.JSONDecodeError):
        return []


def grava_fila(itens):
    FILA.write_text(json.dumps(itens, ensure_ascii=False, indent=2), encoding="utf-8")


def enfileira(novos):
    """Chamado pela emissão. Acrescenta sem duplicar por número de nota."""
    fila = carrega_fila()
    ja = {str(i.get("numero")) for i in fila}
    for n in novos:
        if str(n.get("numero")) not in ja:
            fila.append({**n, "tentativas": 0})
    grava_fila(fila)
    return len(fila)


def write_ipc_task(data):
    IPC_TASKS_DIR.mkdir(parents=True, exist_ok=True)
    fp = IPC_TASKS_DIR / ("%d-%s.json" % (int(time.time() * 1000), rand_id()))
    tmp = Path(str(fp) + ".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.rename(fp)


def agenda_entrega(item, pdf_path, quando):
    """Grava a entrega e agenda o send_nota.py — mesmo mecanismo que já roda em
    produção no caminho ABRASF, para não existirem dois jeitos de enviar."""
    ENTREGAS_DIR.mkdir(parents=True, exist_ok=True)
    eid = "%s-%s" % (item["numero"], rand_id())
    (ENTREGAS_DIR / ("%s.json" % eid)).write_text(json.dumps({
        "telefone": item["telefone"],
        "paciente": item["paciente"],
        "pdf": "/workspace/group/attachments/%s" % Path(pdf_path).name,
        "chat_jid_paciente": "%s@s.whatsapp.net" % item["telefone"],
        "group_folder": item.get("group_folder", "whatsapp_atendimento-dra-marina"),
    }, ensure_ascii=False), encoding="utf-8")
    write_ipc_task({
        "type": "schedule_task",
        "taskId": "nfse-entrega-%d-%s" % (int(time.time() * 1000), rand_id()),
        "prompt": "<internal>Entrega de NFS-e agendada.</internal>",
        "script": "python3 /workspace/group/scripts/send_nota.py %s" % eid,
        "schedule_type": "once",
        "schedule_value": quando.strftime("%Y-%m-%dT%H:%M:%S"),
        "context_mode": "isolated",
        "targetJid": os.environ.get("NANOCLAW_CHAT_JID", ""),
        "createdBy": item.get("group_folder", "whatsapp_atendimento-dra-marina"),
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime()),
    })
    return eid


def main():
    if "--listar" in sys.argv:
        fila = carrega_fila()
        print(json.dumps(fila, ensure_ascii=False, indent=2) if fila else "fila vazia")
        print(json.dumps({"wakeAgent": False}))
        return 0

    fila = carrega_fila()
    if not fila:
        print(json.dumps({"wakeAgent": False, "pendentes": 0}))
        return 0

    lote = fila[:MAX_POR_RODADA]
    numeros = [str(i["numero"]) for i in lote]
    try:
        import nfse_danfse_portal as portal
        baixados = portal.baixa(numeros, ATTACH_DIR)
    except Exception as exc:
        # Falha geral (portal fora, credencial errada): NÃO desiste de nada,
        # a fila inteira fica para a próxima rodada.
        print("coletor falhou: %s" % exc, file=sys.stderr)
        print(json.dumps({"wakeAgent": False, "erro": str(exc)[:200],
                          "pendentes": len(fila)}, ensure_ascii=False))
        return 1

    agora = datetime.now(TZ)
    accum = timedelta(0)
    entregues, desistidos, restantes = [], [], []
    for item in fila:
        num = str(item["numero"])
        if num in baixados:
            if item.get("telefone"):
                accum += timedelta(seconds=random.randint(60, 180)) if entregues else timedelta(0)
                agenda_entrega(item, baixados[num], agora + accum)
                entregues.append((num, item["paciente"]))
            else:
                # PDF existe mas não há telefone: sai da fila mesmo assim, senão
                # seria tentado para sempre. O arquivo fica em attachments/.
                desistidos.append((num, item["paciente"], "sem telefone"))
            continue
        if num not in numeros:
            restantes.append(item)          # nem entrou nesta rodada
            continue
        item["tentativas"] = int(item.get("tentativas", 0)) + 1
        if item["tentativas"] >= MAX_TENTATIVAS:
            desistidos.append((num, item["paciente"],
                               "%d tentativas sem sucesso" % item["tentativas"]))
        else:
            restantes.append(item)

    grava_fila(restantes)

    linhas = []
    if entregues:
        linhas.append("📎 *DANFSE enviado* (%d):" % len(entregues))
        linhas += ["• NFSe *%s* — %s" % (n, p) for n, p in entregues]
    if desistidos:
        linhas.append("\n⚠️ *PDF não obtido* — enviar à mão:")
        linhas += ["• NFSe *%s* — %s (%s)" % (n, p, m) for n, p, m in desistidos]
    if restantes:
        linhas.append("\n_%d na fila para a próxima rodada._" % len(restantes))
    if linhas:
        print("\n".join(linhas))

    # wakeAgent só quando há algo que a recepção precisa ver.
    print(json.dumps({"wakeAgent": bool(desistidos),
                      "entregues": len(entregues),
                      "desistidos": len(desistidos),
                      "pendentes": len(restantes)}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
