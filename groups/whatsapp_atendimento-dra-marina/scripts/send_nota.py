#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Envia o DANFSE (PDF) da NFS-e pro WhatsApp do paciente, como DOCUMENTO anexado,
com a mensagem da clínica. Chamado por uma task 'once' agendada pelo emissor.

Uso: python3 send_nota.py <entrega_id>
Lê /workspace/group/entregas/<id>.json ({telefone, paciente, pdf, chat_jid_paciente,
group_folder}) e escreve uma mensagem IPC type=document.
"""
import json
import os
import sys
import time
import random
import string
from pathlib import Path

GROUP = os.environ.get("NANOCLAW_GROUP_DIR", "/workspace/group")
ENTREGAS_DIR = Path(GROUP) / "entregas"
IPC_MESSAGES_DIR = Path("/workspace/ipc/messages")

MSG = (
    "Olá, sr(a) {nome}!\n\n"
    "Segue em anexo a Nota Fiscal referente ao seu serviço oftalmológico na "
    "Clínica Dra. Marina Costa.\n\n"
    "Permanecemos à disposição caso necessite de qualquer esclarecimento.\n\n"
    "Atenciosamente,\n*Equipe da Clínica Dra. Marina Costa*"
)

# Entrega por LINK, quando a nota é do Padrão Nacional (DPS).
#
# A DPS não devolve código de verificação, e o DANFSE do portal municipal exige
# esse código. O contorno por Playwright no portal da prefeitura ficou de pé até
# 05/10/2026, quando o login do portal saiu do ar por mais de um dia e a SEMF
# não soube dizer por quê.
#
# A consulta pública NACIONAL resolve sem portal, sem navegador e sem captcha do
# nosso lado: quem acessa é o paciente, no navegador dele. Conferido em
# 06/10/2026 que a NFS-e de Teresina está publicada no ambiente nacional
# (`GET sefinnacional/nfse/{chave}` devolve 200).
CONSULTA_NACIONAL = "https://www.nfse.gov.br/consultapublica"

MSG_LINK = (
    "Olá, sr(a) {nome}!\n\n"
    "Sua Nota Fiscal referente ao atendimento na Clínica Dra. Marina Costa já "
    "está emitida.\n\n"
    "Para consultar e baixar, acesse:\n"
    + CONSULTA_NACIONAL
    + "\n\nE informe a chave de acesso:\n{chave}\n\n"
    "Permanecemos à disposição caso necessite de qualquer esclarecimento.\n\n"
    "Atenciosamente,\n*Equipe da Clínica Dra. Marina Costa*"
)


def chave_limpa(chave):
    """Os 50 dígitos da chave de acesso, sem o prefixo `NFS`.

    A API devolve `chaveAcesso` com 53 caracteres: `NFS` + 50 dígitos. O prefixo
    é convenção do atributo `Id` do XML (igual ao `DPS` do `infDPS@Id`) e NÃO
    faz parte da chave. Mandando com ele, a consulta pública responde "Nota
    Fiscal de Serviço inexistente" e o nacional recusa com `E2406` — erro que
    parece nota ausente e é só formato. Custou uma rodada de teste em
    06/10/2026.
    """
    c = (chave or "").strip()
    if c.upper().startswith("NFS"):
        c = c[3:]
    return c


def rand_id(n=6):
    return "".join(random.choices(string.ascii_lowercase + string.digits, k=n))


def primeiro_nome(nome):
    p = (nome or "").strip().split()
    return p[0].capitalize() if p else ""


def write_ipc_message(data):
    IPC_MESSAGES_DIR.mkdir(parents=True, exist_ok=True)
    fp = IPC_MESSAGES_DIR / f"{int(time.time()*1000)}-{rand_id()}.json"
    tmp = Path(str(fp) + ".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2))
    tmp.rename(fp)


def main():
    if len(sys.argv) < 2:
        print("Uso: send_nota.py <entrega_id>", file=sys.stderr)
        sys.exit(1)
    ent_file = ENTREGAS_DIR / f"{sys.argv[1]}.json"
    if not ent_file.exists():
        print(f"Entrega não encontrada: {ent_file}", file=sys.stderr)
        sys.exit(1)
    ent = json.loads(ent_file.read_text())

    nome = primeiro_nome(ent.get("paciente"))
    comum = {
        "origin": "send_nota",  # exigido pelo core: só script fala com paciente
        "chatJid": ent["chat_jid_paciente"],
        "groupFolder": ent.get("group_folder", "whatsapp_atendimento-dra-marina"),
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime()),
    }

    # PDF quando existe; senão, link da consulta nacional com a chave. A ordem
    # importa: se um dia o DANFSE voltar a ser obtível, o anexo volta a valer
    # sem mudar nada aqui.
    if ent.get("pdf"):
        write_ipc_message({
            **comum,
            "type": "document",
            "filePath": ent["pdf"],
            "fileName": "Nota_Fiscal.pdf",
            "caption": MSG.format(nome=nome),
        })
    elif ent.get("chave"):
        chave = chave_limpa(ent["chave"])
        if len(chave) != 50 or not chave.isdigit():
            print(
                f"Chave inválida para {ent.get('paciente')}: {len(chave)} caracteres. "
                "NÃO enviei nada: link com chave errada faz o paciente achar que a "
                "nota não existe.",
                file=sys.stderr,
            )
            sys.exit(1)
        write_ipc_message({
            **comum,
            "type": "text",
            "message": MSG_LINK.format(nome=nome, chave=chave),
        })
    else:
        print(
            f"Entrega {sys.argv[1]} não tem pdf nem chave; nada a enviar.",
            file=sys.stderr,
        )
        sys.exit(1)
    ent_file.unlink()
    print(f"Nota enviada ao paciente {ent.get('paciente')} ({ent['chat_jid_paciente']}).")


if __name__ == "__main__":
    main()
