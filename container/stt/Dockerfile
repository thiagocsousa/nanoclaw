# Transcrição de áudio de paciente, 100% local.
#
# ## Por que uma imagem separada, e não dentro do agent
#
# A VM tem 2 GB e ~880 MB livres, e o Thiago decidiu em 04/10/2026 tentar o
# modelo `base` sem redimensionar. Container próprio permite `--memory`: se
# faltar RAM, o OOM killer mata ESTA transcrição e o nanoclaw nem sente. Dentro
# da imagem do agent, um estouro derrubaria o processo que atende todos os
# grupos.
#
# Também mantém a imagem do agent enxuta: STT pesa ~400 MB e é usado em poucas
# mensagens.
#
# ## Por que `small`, e por que não era `base`
#
# `tiny` cabe em 300 MB mas erra muito em português falado, e aqui errar inverte
# decisão: "não está doendo" virando "está doendo" muda o escalonamento.
#
# `base` foi a primeira escolha, por caber na VM de 2 GB sem redimensionar. A
# medição de 17/10/2026 no áudio real do Thiago reprovou: `base` com beam 1 deu
# confiança 0.31 e "O Pereio ontem meu oitado indo no mundo". Com qualquer piso
# útil, isso significa que NENHUMA transcrição é entregue — ligar o STT com
# `base` gastava 90 s de CPU por áudio para sempre cair no marcador.
#
# `small` int8 com beam 5 e vocabulário deu 0.62 no mesmo áudio e acertou
# "Operei ontem". A RAM não era o gargalo que eu supus: medido, o small rodou com
# teto de 1,2 GB e sobraram 1,3 GB livres na VM.
#
# ## Por que o modelo vem embutido
#
# Baixar em tempo de execução somaria 10 a 30 s na primeira mensagem e falharia
# se a VM estivesse sem rede. Embutido, o container sobe e transcreve.
FROM python:3.11-slim

# ffmpeg converte o opus/ogg do WhatsApp; o resto é o runtime do ctranslate2.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# `requests` não vem como dependência do faster-whisper, mas o download do
# modelo passa pelo huggingface_hub e quebra sem ele:
#   ModuleNotFoundError: No module named 'requests'
RUN pip install --no-cache-dir faster-whisper==1.0.3 requests

# Baixa o modelo na build e congela em /modelo. CT2 int8 reduz o peso e a RAM
# com perda pequena de acerto.
ENV MODELO=small
RUN python3 -c "\
from faster_whisper import WhisperModel; \
WhisperModel('small', device='cpu', compute_type='int8', download_root='/modelo')"

COPY transcrever.py /app/transcrever.py
WORKDIR /app

# Sem rede em tempo de execução: o modelo já está no disco e áudio de paciente
# não deve poder sair da máquina nem por acidente. O host passa --network none.
ENTRYPOINT ["python3", "/app/transcrever.py"]
