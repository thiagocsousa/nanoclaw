/**
 * Transcrição de áudio de paciente, local e isolada.
 *
 * ## Por que existe
 *
 * Até 04/10/2026 o áudio era descartado em silêncio: a extração de conteúdo não
 * conhecia `audioMessage`, o texto ficava vazio e a mensagem era engolida. Quem
 * mandava áudio nunca era respondido. O primeiro conserto foi um marcador
 * (`[áudio recebido, 12s]`), que ao menos deixa a agente pedir por escrito.
 *
 * Este módulo é o passo seguinte: transcrever para conseguir **rotear a
 * intenção** de quem não quer ou não consegue digitar.
 *
 * ## As decisões que moldaram a implementação
 *
 * **Local, nunca API.** Áudio de paciente descrevendo sintoma é o dado mais
 * sensível que passa pelo sistema. Decisão do Thiago em 04/10/2026: modelo na
 * própria VM, e o container roda com `--network none` para que o áudio não possa
 * sair nem por acidente. Mesma postura que já existe no `escalar.py`, onde o
 * texto do ntfy é genérico porque ntfy.sh é servidor de terceiro.
 *
 * **Container próprio com teto de memória.** A VM tem 2 GB, com ~880 MB livres,
 * e o Thiago optou por tentar o modelo `base` sem redimensionar. Com
 * `--memory`, faltar RAM mata a transcrição e **não** o nanoclaw, que atende
 * todos os grupos. Sem o teto, um estouro levaria o processo inteiro.
 *
 * **Transcrição incerta é tratada como ausência de transcrição.** Aqui errar
 * inverte decisão: "não está doendo" virando "está doendo" muda o
 * escalonamento. Então o viés é pessimista, e qualquer dúvida volta ao
 * comportamento de pedir por escrito.
 *
 * **Toda falha degrada para o marcador.** Imagem ausente, docker fora, OOM,
 * timeout, JSON inválido: a agente continua respondendo. O bug original era o
 * paciente ficar sem resposta, e nada aqui pode recriá-lo.
 */
import fs from 'fs';
import path from 'path';

import { readonlyMountArgs } from './container-runtime.js';
import { readEnvFile } from './env.js';
import { nomeiaContainer, rodaScript } from './script-container.js';
import { logger } from './logger.js';

const envConfig = readEnvFile([
  'STT_IMAGE',
  'STT_MEMORY',
  'STT_TIMEOUT_MS',
  'STT_ENABLED',
  'STT_MODELO',
  'STT_BEAM',
  'STT_PISO_CONFIANCA',
  'STT_PISO_URGENCIA',
]);

function env(key: string, fallback: string): string {
  return process.env[key] || envConfig[key] || fallback;
}

const IMAGE = env('STT_IMAGE', 'nanoclaw-stt:latest');
/** Teto de RAM do container. `base` int8 fica em ~500 MB; 800 MB dá margem. */
const MEMORY = env('STT_MEMORY', '800m');
/**
 * Teto de tempo. A transcrição roda dentro do handler de mensagem, então um
 * áudio longo atrasaria o atendimento de todos os grupos. 90 s cobre um áudio
 * de ~2 min no `base`; acima disso o marcador é melhor que a espera.
 */
const TIMEOUT_MS = parseInt(env('STT_TIMEOUT_MS', '90000'), 10);
/**
 * DESLIGADO por default desde 04/10/2026, por medição, não por precaução.
 *
 * Num áudio real de 6 s do Thiago ("operei ontem, meu olho tá doendo...",
 * reconstruído), três configurações:
 *
 *   base,  beam 1              conf 0.31  "O Pereio ontem meu oitado indo no mundo"
 *   small, beam 1              conf 0.45  "O Pereio ontem meu oito está doendo o mundo"
 *   small, beam 5 + vocabulário conf 0.62  "Operei ontem meu oitado do Índio do Mundo"
 *
 * O problema não é o acerto médio: é que a **confiança está anticorrelacionada
 * com o acerto clínico**. A configuração que captou "está doendo" ficou em 0.45,
 * abaixo do piso, e seria descartada; a que passa o piso (0.62) transformou a
 * queixa em "do Índio do Mundo". Nenhum ajuste de piso resolve isso, porque
 * subir para 0.7 rejeita tudo, o que equivale a desligar.
 *
 * Transcrição que erra o sintoma **com confiança alta** inverte a decisão de
 * escalonamento, e isso é pior que não transcrever. O marcador já conserta o bug
 * que importava: antes, áudio era descartado em silêncio e o paciente nunca era
 * respondido.
 *
 * RAM não foi o gargalo: o `small` rodou com teto de 1,2 GB e o nanoclaw nem
 * sentiu. Se um dia houver máquina para `medium`/`large-v3`, vale remedir, e a
 * infraestrutura toda (imagem, volume, travas) fica pronta aqui.
 */
const ENABLED = env('STT_ENABLED', 'false') === 'true';

/**
 * Dois pisos, porque são dois usos com riscos OPOSTOS.
 *
 * A medição de 17/10/2026 no áudio real do Thiago mostrou a confiança
 * anticorrelacionada com o acerto clínico: a configuração que capturou "está
 * doendo" ficou em 0.45 e seria descartada; a que passou o piso (0.62) virou a
 * queixa em "do Índio do Mundo". Com um piso só, não há escolha boa — subir
 * rejeita tudo, descer entrega palpite como fala do paciente.
 *
 * Decisão do Thiago no mesmo dia: separar os dois.
 *
 *   PISO_CONFIANCA (alto)  → a transcrição pode ser CITADA como fala dele.
 *                            Errar aqui põe palavra na boca do paciente.
 *   PISO_URGENCIA  (baixo) → a transcrição pode levantar SUSPEITA de queixa
 *                            clínica. Errar aqui escala um caso que não era
 *                            urgente, e um humano lê e fecha.
 *
 * O erro troca de lado, e é esse o ganho: falso positivo escala, falso negativo
 * pede texto — que é exatamente o comportamento de antes. Nenhum caminho novo
 * entrega texto incerto ao paciente.
 */
const PISO_CONFIANCA = parseFloat(env('STT_PISO_CONFIANCA', '0.60'));
const PISO_URGENCIA = parseFloat(env('STT_PISO_URGENCIA', '0.30'));
const MODELO = env('STT_MODELO', 'small');
const BEAM = env('STT_BEAM', '5');

/**
 * Vocabulário de queixa clínica. Igual ao `RX_DOR` da guarda de saída, e
 * deliberadamente largo: aqui um falso positivo custa um escalonamento a mais,
 * então errar para o lado de escalar é o projeto.
 */
const RX_QUEIXA =
  /\b(?:dor|dores|doendo|doer|d[óo]i|ardendo|arder|queimando|incomodando|urg[êe]ncia|urgente|p[óo]s[-\s]?operat[óo]rio|operei|cirurgia|inchad|vermelh|secre[çc][ãa]o|vista escura|n[ãa]o (?:estou |to )?vendo|emba[çc]ad|sangrando|sangue)/i;

export interface Transcricao {
  texto: string;
  segundos: number;
  confianca: number;
  incerta: boolean;
  motivo?: string;
}

/**
 * Marcador usado quando não há transcrição utilizável. É o texto que a agente
 * recebe, e o FAQ (F00d) manda pedir por escrito ao vê-lo.
 */
export function marcadorDeAudio(segundos?: number): string {
  const s = segundos && segundos > 0 ? `, ${Math.round(segundos)}s` : '';
  return `[áudio recebido${s}, não transcrito]`;
}

/**
 * Marcador de áudio que a transcrição não deu para citar, mas em que apareceu
 * palavra de queixa clínica.
 *
 * ⚠️ O texto transcrito NÃO entra aqui. Ele é incerto e é fala de paciente
 * sobre saúde: entregá-lo à agente seria a mesma coisa que citá-lo, e é o que
 * o piso alto existe para impedir. O que atravessa é só o fato de que havia
 * sinal de queixa — o suficiente para a classificação cair em `clinico` e o
 * host escalar como urgente, que é o desfecho seguro.
 */
export function marcadorDeQueixa(segundos?: number): string {
  const s = segundos && segundos > 0 ? `, ${Math.round(segundos)}s` : '';
  return (
    `[áudio recebido${s}, não transcrito com segurança — ` +
    `a transcrição incerta trouxe sinal de queixa clínica]`
  );
}

/**
 * Monta o texto que a agente vê. Transcrição incerta NÃO é entregue como fala
 * do paciente: vira marcador, porque agir sobre palpite é pior que admitir que
 * não entendeu.
 */
export function textoParaAgente(
  t: Transcricao | undefined,
  segundos?: number,
): string {
  if (!t || !t.texto) return marcadorDeAudio(t?.segundos ?? segundos);
  if (t.incerta) {
    // Incerta demais para citar, confiável o bastante para suspeitar: vira
    // marcador de queixa, não resposta. Ver PISO_URGENCIA.
    if (t.confianca >= PISO_URGENCIA && RX_QUEIXA.test(t.texto)) {
      return marcadorDeQueixa(t.segundos ?? segundos);
    }
    return marcadorDeAudio(t.segundos ?? segundos);
  }
  return `[áudio transcrito, ${Math.round(t.segundos)}s] ${t.texto}`;
}

export function parseSaidaStt(saida: string): Transcricao | undefined {
  try {
    // A última linha é o JSON; faster-whisper às vezes escreve aviso antes.
    const linha = saida
      .trim()
      .split('\n')
      .reverse()
      .find((l) => l.trim().startsWith('{'));
    if (!linha) return undefined;
    const j = JSON.parse(linha) as Record<string, unknown>;
    if (j.ok !== true) return undefined;
    return {
      texto: String(j.texto ?? ''),
      segundos: Number(j.segundos ?? 0),
      confianca: Number(j.confianca ?? 0),
      incerta: j.incerta === true,
      motivo: j.motivo ? String(j.motivo) : undefined,
    };
  } catch {
    return undefined;
  }
}

/**
 * Transcreve o arquivo. Nunca lança: devolve undefined e o chamador usa o
 * marcador.
 */
export async function transcreveAudio(
  arquivo: string,
): Promise<Transcricao | undefined> {
  if (!ENABLED) return undefined;
  if (!fs.existsSync(arquivo)) return undefined;

  const dir = path.dirname(arquivo);
  const nome = path.basename(arquivo);
  // ⚠️ `--name`, para poder COLHER o container.
  //
  // Sem ele o container nascia com nome aleatório do Docker, e aí era
  // invisível tanto para `cleanupOrphans()` quanto para
  // `colheScriptsEsquecidos()` — foi exatamente assim que um `iclinic_vagas.py`
  // chamado `inspiring_hofstadter` viveu uma HORA na VM em 19/10/2026.
  //
  // E aqui o vazamento é PIOR que no caminho do iClinic: este container pede
  // `--cpus=1.5` numa máquina de 2 núcleos, então um órfão fica com 75% da VM.
  // Está no caminho de áudio de PACIENTE, onde ninguém olha o log na hora.
  //
  // O prefixo de script faz a varredura periódica cobrir este container: o
  // teto do STT é 90 s, então um de 5 minutos é, por definição, órfão.
  const containerName = nomeiaContainer('stt');
  const args = [
    'run',
    '--rm',
    '--name',
    containerName,
    '--network',
    'none', // áudio de paciente não sai da máquina
    `--memory=${MEMORY}`,
    '--memory-swap',
    MEMORY, // sem swap: estourar deve falhar rápido, não arrastar a VM
    // ⚠️ `--cpus` aqui é teto RÍGIDO e deliberado do autor, diferente do
    // `--cpu-shares` dos containers de script: whisper descontrolado numa VM de
    // 2 núcleos não pode engolir a máquina. Mantido como estava — o defeito
    // deste arquivo era o ciclo de vida, não o limite.
    '--cpus=1.5',
    // O piso de citação é do CONTÊINER (ele marca `incerta`); o de urgência é
    // do host, porque é ele que conhece o vocabulário de queixa.
    '-e',
    `MODELO=${MODELO}`,
    '-e',
    `STT_BEAM=${BEAM}`,
    '-e',
    `STT_PISO_CONFIANCA=${PISO_CONFIANCA}`,
    ...readonlyMountArgs(dir, '/audio'),
    IMAGE,
    `/audio/${nome}`,
  ];

  // ⚠️ `rodaScript` em vez de `execFile('docker', ...)`: o binário estava
  // CRAVADO como 'docker' aqui, o que quebraria na migração para o Apple
  // Container, e o `timeout` do `execFile` matava o cliente sem matar o
  // container. Quem possui spawn, timeout e colheita é `script-container.ts`.
  const { stdout, stderr, erro, timeout } = await rodaScript({
    nome: containerName,
    args,
    timeoutMs: TIMEOUT_MS,
    maxBuffer: 1024 * 1024,
  });
  if (erro) {
    logger.warn(
      { err: erro, arquivo: nome, timeout },
      'stt: transcrição falhou, usando marcador',
    );
    return undefined;
  }
  const t = parseSaidaStt(stdout);
  if (!t) {
    logger.warn(
      { arquivo: nome, stderr: stderr.slice(0, 200) },
      'stt: saída não interpretável',
    );
    return undefined;
  }
  logger.info(
    {
      arquivo: nome,
      segundos: t.segundos,
      confianca: t.confianca,
      incerta: t.incerta,
      motivo: t.motivo,
      // O TEXTO não vai para o log: é fala de paciente sobre saúde.
      caracteres: t.texto.length,
    },
    'stt: transcrito',
  );
  return t;
}
