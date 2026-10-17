#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Transcreve um áudio e devolve JSON numa linha. Roda offline, sem rede.

Uso:  transcrever.py /audio/nota.ogg

Saída (sempre JSON, mesmo em falha):
  {"ok": true, "texto": "...", "segundos": 14.2, "confianca": 0.78,
   "idioma": "pt", "incerta": false}
  {"ok": false, "erro": "..."}

## Confiança, e por que ela importa aqui

`avg_logprob` do Whisper é log-probabilidade média por token. Valores perto de 0
indicam alta certeza; abaixo de -1.0 o modelo está praticamente adivinhando.
Converto para 0..1 só para o host ter um número fácil de comparar, mas o que
decide é o campo `incerta`.

Neste domínio, transcrição errada é pior que nenhuma: "não está doendo" virando
"está doendo" inverte a decisão de escalonamento. Então o viés é pessimista, e
`incerta` fica true em qualquer um destes casos:

  - confiança abaixo do piso
  - `no_speech_prob` alto (ruído, trecho sem fala)
  - nenhum segmento reconhecido
  - idioma detectado diferente de português

O host trata `incerta` como se não houvesse transcrição: a agente pede por
escrito, em vez de agir sobre um palpite.
"""
import json
import os
import sys

# Piso para a transcrição valer como FALA DO PACIENTE, que é o uso perigoso:
# citar errado com confiança alta é pior que não citar. Medido em 17/10/2026, o
# `small` com beam 5 e vocabulário deu 0.62 no áudio real do Thiago.
PISO_CONFIANCA = float(os.environ.get("STT_PISO_CONFIANCA", "0.60"))
TETO_SEM_FALA = float(os.environ.get("STT_TETO_SEM_FALA", "0.55"))
MODELO = os.environ.get("MODELO", "small")
# Beam 5 melhorou de 0.45 para 0.62 no mesmo áudio. O comentário antigo dizia
# que "beam maior não compensa em 2 vCPU" — era suposição, e a medição a
# desmentiu. O custo é tempo, e o teto de 90 s do host absorve.
BEAM = int(os.environ.get("STT_BEAM", "5"))
# `initial_prompt` do whisper: nomes e termos que a clínica usa, para o modelo
# não inventar vizinhos fonéticos. Sem isto, "Operei ontem" saiu "O Pereio
# ontem".
VOCABULARIO = os.environ.get(
    "STT_VOCABULARIO",
    "Consulta com a Dra. Marina Costa, oftalmologista em Teresina. "
    "Cirurgia de catarata, cirurgia refrativa, lente intraocular, "
    "Pentacam, topografia, mapeamento de retina. "
    "Operei, pós-operatório, colírio, dor, ardendo, visão embaçada. "
    "Unimed, IASPI, IPMT, PLAMTA, PLANTE, particular.",
)


def confianca_de(avg_logprob):
    """avg_logprob (-inf..0) -> 0..1, com -1.0 virando 0."""
    return max(0.0, min(1.0, 1.0 + float(avg_logprob)))


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"ok": False, "erro": "uso: transcrever.py <arquivo>"}))
        return 2
    caminho = sys.argv[1]
    if not os.path.exists(caminho):
        print(json.dumps({"ok": False, "erro": "arquivo não existe"}))
        return 1

    try:
        from faster_whisper import WhisperModel

        modelo = WhisperModel(
            MODELO, device="cpu", compute_type="int8", download_root="/modelo"
        )
        segmentos, info = modelo.transcribe(
            caminho,
            language="pt",            # fixo: a clínica atende em português
            vad_filter=True,          # corta silêncio, melhora acerto e tempo
            beam_size=BEAM,
            initial_prompt=VOCABULARIO or None,
        )
        segs = list(segmentos)
    except Exception as exc:  # noqa: BLE001 - qualquer falha degrada para marcador
        print(json.dumps({"ok": False, "erro": "%s: %s" % (type(exc).__name__, exc)},
                         ensure_ascii=False))
        return 1

    if not segs:
        print(json.dumps({"ok": True, "texto": "", "incerta": True,
                          "confianca": 0.0, "segundos": round(info.duration, 1),
                          "idioma": info.language, "motivo": "nenhum segmento de fala"},
                         ensure_ascii=False))
        return 0

    texto = " ".join(s.text.strip() for s in segs).strip()
    confs = [confianca_de(s.avg_logprob) for s in segs]
    conf = sum(confs) / len(confs)
    sem_fala = max(getattr(s, "no_speech_prob", 0.0) or 0.0 for s in segs)

    motivos = []
    if conf < PISO_CONFIANCA:
        motivos.append("confiança %.2f abaixo do piso %.2f" % (conf, PISO_CONFIANCA))
    if sem_fala > TETO_SEM_FALA:
        motivos.append("no_speech_prob %.2f" % sem_fala)
    if info.language != "pt":
        motivos.append("idioma detectado %s" % info.language)
    if not texto:
        motivos.append("texto vazio")

    print(json.dumps({
        "ok": True,
        "texto": texto,
        "segundos": round(info.duration, 1),
        "confianca": round(conf, 2),
        "idioma": info.language,
        "incerta": bool(motivos),
        "motivo": "; ".join(motivos),
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
