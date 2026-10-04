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
import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';

const envConfig = readEnvFile([
  'STT_IMAGE',
  'STT_MEMORY',
  'STT_TIMEOUT_MS',
  'STT_ENABLED',
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
 * Monta o texto que a agente vê. Transcrição incerta NÃO é entregue como fala
 * do paciente: vira marcador, porque agir sobre palpite é pior que admitir que
 * não entendeu.
 */
export function textoParaAgente(
  t: Transcricao | undefined,
  segundos?: number,
): string {
  if (!t || t.incerta || !t.texto)
    return marcadorDeAudio(t?.segundos ?? segundos);
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
  const args = [
    'run',
    '--rm',
    '--network',
    'none', // áudio de paciente não sai da máquina
    `--memory=${MEMORY}`,
    '--memory-swap',
    MEMORY, // sem swap: estourar deve falhar rápido, não arrastar a VM
    '--cpus=1.5',
    '-v',
    `${dir}:/audio:ro`,
    IMAGE,
    `/audio/${nome}`,
  ];

  return new Promise((resolve) => {
    execFile(
      'docker',
      args,
      { timeout: TIMEOUT_MS, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          logger.warn(
            { err: err.message, arquivo: nome },
            'stt: transcrição falhou, usando marcador',
          );
          return resolve(undefined);
        }
        const t = parseSaidaStt(stdout);
        if (!t) {
          logger.warn(
            { arquivo: nome, stderr: stderr.slice(0, 200) },
            'stt: saída não interpretável',
          );
          return resolve(undefined);
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
        resolve(t);
      },
    );
  });
}
