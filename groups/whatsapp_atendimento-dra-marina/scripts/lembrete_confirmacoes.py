#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Resumo das confirmações de lembrete de consulta — roda no MESMO dia da coleta,
às 17h (2h após o envio das 15h). Lê o manifesto gerado hoje + o log passivo de
respostas dos pacientes (lembrete_respostas.jsonl, alimentado pelo core) e
classifica cada paciente em SIM / NÃO / a conferir / sem resposta.

Imprime {"wakeAgent": true, "data": {...}} → o agente é acordado NO GRUPO do
atendimento e posta o resumo lá. O agente NUNCA fala com o paciente.
Se não houve coleta hoje (fim de semana/feriado) → {"wakeAgent": false}.

## Desde 30/10/2026 também ESCREVE na agenda

Quem confirmou passa a `CONFIRMADO_PACIENTE` na Clínica nas Nuvens, para a
recepção ver o estado na própria agenda em vez de cruzar com uma mensagem de
WhatsApp. Antes disso nenhum dos dois sistemas recebia a confirmação de volta —
não é regressão da migração, é capacidade que a CNN trouxe.

⛔ **Só confirma. Nunca cancela.** Um "não vou" não vira `CANCELADO_PACIENTE`:
confirmar quem não vem custa um horário que a recepção já vê no resumo;
cancelar quem vem perde a vaga e o paciente, a partir de uma classificação de
texto livre que erra com "não sei ainda" e "não posso de manhã". Quem cancela é
gente. A regra mora no `cnn.confirma_presenca`.

⚠️ A escrita NUNCA derruba o resumo. O resumo é o trabalho; o status é o
bônus — e um bônus que apaga o trabalho principal é um defeito.

Flags: --dry-run não escreve nada e diz o que escreveria.
Env `LEMBRETE_CONFIRMA_CNN=0` desliga a escrita sem precisar de deploy.
"""
import argparse
import json
import os
import re
import sys
import unicodedata
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cnn  # noqa: E402

GROUP = os.environ.get("NANOCLAW_GROUP_DIR", "/workspace/group")
MANIFEST_ULTIMO = Path(GROUP) / "lembrete_manifest_ultimo.json"
RESPOSTAS = Path(GROUP) / "lembrete_respostas.jsonl"

TZ = timezone(timedelta(hours=-3))  # America/Fortaleza

SIM = ("sim", "confirmo", "confirmado", "confirmar", "confirma", "ok", "okay",
       "isso", "pode", "podem", "claro", "positivo", "blz", "beleza", "vou",
       "estarei", "comparecer", "comparecerei", "certo", "perfeito", "👍", "✅")
NAO = ("nao", "remarcar", "remarca", "cancelar", "cancela", "desmarcar",
       "desmarca", "negativo", "impossivel", "consigo nao", "outro dia",
       "outra data", "🔄", "❌", "❎")


def norm(s):
    s = unicodedata.normalize("NFKD", s or "").encode("ascii", "ignore").decode()
    return s.lower().strip()


def match_key(phone):
    d = re.sub(r"\D", "", phone or "")
    if len(d) < 12:
        return d
    return "55" + d[2:4] + d[-8:]


def classify(text):
    t = norm(text)
    raw = (text or "").strip()
    # NÃO tem prioridade sobre SIM ("não posso" contém "posso" que não é SIM)
    if any(k in t for k in NAO) or "❌" in raw or "🔄" in raw:
        return "nao"
    if any(k in t for k in SIM) or "👍" in raw or "✅" in raw:
        return "sim"
    return "outro"


def parse_ts(iso):
    try:
        return datetime.fromisoformat((iso or "").replace("Z", "+00:00")).timestamp()
    except Exception:
        return 0.0


def escreve_confirmacoes(confirmados, dry_run=False):
    """Marca CONFIRMADO_PACIENTE em quem respondeu sim. Devolve o relatório.

    ⚠️ Acrescenta `cnn` a cada item (`alterado`, `ja_confirmado`,
    `status_mudou:X`, `sem_id`, `erro:...`) para o resumo poder dizer à
    recepção o que ficou de fora e por quê. Status que mudou entre 15h e 17h é
    informação que ela quer: significa que alguém já mexeu naquele horário.
    """
    rel = {"alterados": 0, "ja_confirmados": 0, "pulados": 0, "erros": 0}
    if os.environ.get("LEMBRETE_CONFIRMA_CNN", "1") == "0":
        rel["desligado"] = True
        return rel
    for item in confirmados:
        ida = item.get("agenda_id")
        if not ida:
            # Manifesto antigo, de antes de 30/10: não tem o id. Não é erro —
            # some sozinho no dia seguinte, quando a coleta regrava.
            item["cnn"] = "sem_id"
            rel["pulados"] += 1
            continue
        if dry_run:
            item["cnn"] = "dry-run"
            continue
        try:
            resultado, _ = cnn.confirma_presenca(ida)
        except cnn.CnnIndisponivel as exc:
            # ⛔ Engole de propósito: o resumo tem de sair mesmo com a CNN fora.
            item["cnn"] = f"erro:{str(exc)[:80]}"
            rel["erros"] += 1
            continue
        item["cnn"] = resultado
        if resultado == "alterado":
            rel["alterados"] += 1
        elif resultado == "ja_confirmado":
            rel["ja_confirmados"] += 1
        else:
            rel["pulados"] += 1
    return rel


def main():
    hoje = datetime.now(TZ).strftime("%Y-%m-%d")
    if not MANIFEST_ULTIMO.exists():
        print(json.dumps({"wakeAgent": False, "data": {"message": "Sem manifesto."}}))
        return
    manifest = json.loads(MANIFEST_ULTIMO.read_text())
    if manifest.get("gerado_em_data") != hoje:
        # coleta não rodou hoje (fim de semana/feriado) — nada a resumir
        print(json.dumps({"wakeAgent": False,
                          "data": {"message": "Sem coleta hoje."}}))
        return

    since = float(manifest.get("gerado_em_epoch") or 0)
    pacientes = manifest.get("pacientes", [])

    # Índice das respostas por match_key (só as recebidas após o envio)
    respostas = {}
    if RESPOSTAS.exists():
        for line in RESPOSTAS.read_text().splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                r = json.loads(line)
            except Exception:
                continue
            if parse_ts(r.get("timestamp")) < since:
                continue
            k = match_key(r.get("phone") or r.get("jid", "").split("@")[0])
            respostas.setdefault(k, []).append(r)

    confirmados, recusados, conferir, sem_resposta = [], [], [], []
    for p in pacientes:
        k = p.get("match_key") or match_key(p.get("telefone"))
        msgs = respostas.get(k, [])
        item = {"nome": p["nome"], "hora": p.get("hora"),
                "proc": p.get("procedimento"), "agenda_id": p.get("agenda_id")}
        if not msgs:
            sem_resposta.append(item)
            continue
        # usa a ÚLTIMA resposta do paciente
        last = sorted(msgs, key=lambda m: parse_ts(m.get("timestamp")))[-1]
        item["resposta"] = (last.get("text") or "").strip()[:120]
        c = classify(last.get("text"))
        (confirmados if c == "sim" else recusados if c == "nao" else conferir).append(item)

    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    args, _ = ap.parse_known_args()
    status_cnn = escreve_confirmacoes(confirmados, dry_run=args.dry_run)

    data = {
        "status_cnn": status_cnn,
        "alvo": manifest.get("alvo_disp"),
        "dia_semana": manifest.get("dia_semana"),
        "total": len(pacientes),
        "confirmados": confirmados,
        "recusados": recusados,
        "conferir": conferir,
        "sem_resposta": sem_resposta,
    }
    print(json.dumps({"wakeAgent": True, "data": data}, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        import traceback
        print(json.dumps({"wakeAgent": False,
                          "data": {"error": str(e), "traceback": traceback.format_exc()}}))
