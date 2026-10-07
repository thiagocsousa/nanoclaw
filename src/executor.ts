/**
 * Executor da tabela de templates: o host escolhe o texto, não o modelo.
 *
 * ## O que muda em relação ao grupo de teste
 *
 * No grupo de teste a Lara redige livremente e a guarda de saída inspeciona o
 * texto depois. Isso pega o que é mecanicamente detectável e **não torna
 * invenção impossível**. Aqui a garantia é outra: o texto que chega ao paciente
 * foi lido e aprovado pela clínica **antes de existir**. O modelo só devolve um
 * rótulo, e um rótulo não pode conter um preço errado.
 *
 * ## Por que o host escala
 *
 * Decisão do Thiago em 04/10/2026. Até aqui a escalada era o agente chamando
 * `escalar.py`, e isso dependia de o modelo lembrar de chamar a ferramenta: em
 * 03/10 ele "escalou" 10 de 10 vezes e a clínica não soube de nenhuma. Com o
 * executor, `acao: 'escalar'` na tabela é o host agindo, e não existe caminho em
 * que a intenção seja de escalonamento e nada aconteça.
 *
 * ## Falha fecha
 *
 * Tudo que dá errado converge para escalonamento, nunca para silêncio nem para
 * texto improvisado: saída que não é JSON, intenção fora da tabela, confiança
 * abaixo do limiar, slot obrigatório ausente. Quem resolve é um humano, e o
 * paciente recebe "Só um instante." em vez de ficar esperando.
 */
import { readEnvFile } from './env.js';
import { escala, type EscalationSlaDeps } from './escalation-sla.js';
import { logger } from './logger.js';
import {
  candidatosLembrados,
  comLembrados,
  jaPerguntouPaciente,
  lembraCandidatos,
  lembraPacienteConfirmado,
  lembraSlots,
  marcaPerguntouPaciente,
  pacienteConfirmado,
} from './memoria-conversa.js';
import { pacientesComTelefone, primeiroNome } from './paciente.js';
import { interpreta } from './classify.js';
import {
  carregaTabela,
  renderiza,
  type Resultado,
  type Tabela,
} from './templates.js';
import {
  esqueceOferta,
  marca,
  type OfertaPendente,
  registraOferta,
  telefoneDoJid,
  ultimaOferta,
} from './agendamento.js';
import { fraseDeTriagem } from './triagem.js';
import {
  buscaVagas,
  perfilDe,
  slotsDaVaga,
  soHumano,
  temDescontoDeConsulta,
  type Vaga,
} from './vagas.js';

const envConfig = readEnvFile(['TEMPLATE_FOLDERS']);

const FOLDERS = new Set(
  (process.env.TEMPLATE_FOLDERS || envConfig.TEMPLATE_FOLDERS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
);

/**
 * A pasta responde por tabela, em vez de redigir livre. Fica desligado por
 * padrão: o grupo de teste mede tom e invenção justamente sem templates, e
 * ligar os dois ao mesmo tempo apagaria a medição.
 */
export function wantsTemplates(groupFolder?: string): boolean {
  return !!groupFolder && FOLDERS.has(groupFolder);
}

/**
 * O script aceita `--dia` só em ISO. O classificador extrai `dia_pedido` como o
 * paciente falou ("sábado", "amanhã"), que não é data, então só repassamos o
 * que já estiver em ISO. O resto vai sem `--dia`, e o script devolve o próximo
 * disponível, que é a resposta certa para "tem vaga?".
 */
function diaIso(dia_pedido?: string): string | undefined {
  return dia_pedido && /^\d{4}-\d{2}-\d{2}$/.test(dia_pedido)
    ? dia_pedido
    : undefined;
}

/**
 * A lista de intenções, para o HOST pôr no prompt.
 *
 * ## Por que o host injeta em vez de o agente ler o arquivo
 *
 * O `CLAUDE.md` mandava ler `templates.json`, e em 04/10/2026, no primeiro teste
 * em produção, o agente **não leu**: devolveu `endereco_clinica`, que não existe
 * (o nome é `endereco`), o parser rejeitou e o caso escalou. Ele inventou o nome
 * exatamente como o prompt avisava que aconteceria.
 *
 * Isso também expôs um furo na medição: o avaliador SEMPRE injetava a lista no
 * prompt, então os 92,1% foram medidos com ela e produção não a tinha. Pedir ao
 * modelo que leia um arquivo é depender de ele fazer a coisa certa, que é o que
 * esta arquitetura existe para não fazer. Agora é o host que põe.
 */
export function listaDeIntencoes(groupFolder: string): string | undefined {
  const tabela = carregaTabela(groupFolder);
  if (!tabela) return undefined;
  const linhas = Object.entries(tabela.intencoes)
    .filter(([nome]) => nome !== 'DESCONHECIDO')
    .map(([nome, d]) => `- **${nome}**: ${d.quando ?? ''}`);
  return [
    '## Intenções disponíveis',
    '',
    'Esta é a lista COMPLETA e os nomes são exatos. Nome fora desta lista é',
    'tratado como DESCONHECIDO e escala, então não invente nem abrevie.',
    '',
    ...linhas,
    '- **DESCONHECIDO**: nada acima serve, ou confiança abaixo do limiar',
  ].join('\n');
}

/**
 * Troca a intenção quando o desconto da consulta se aplica.
 *
 * `preco_consulta` e `convenio_nao_atendido` citam R$ 430. Para quem tem
 * intenção de cirurgia E plano não aceito, o valor é R$ 300, e quem sabe disso
 * é o host (ver `temDescontoDeConsulta`). O modelo continua rotulando o que o
 * paciente perguntou; só o texto escolhido muda.
 */
function comDesconto(
  intencao: string,
  slots: Record<string, string | undefined>,
  tabela: Tabela,
): string {
  if (intencao !== 'preco_consulta' && intencao !== 'convenio_nao_atendido') {
    return intencao;
  }
  if (!tabela.intencoes.desconto) return intencao;
  return temDescontoDeConsulta(slots.necessidade, slots.convenio)
    ? 'desconto'
    : intencao;
}

/** `1980-06-01` -> `01/06/1980`. O iClinic devolve ISO; o resto do fluxo usa BR. */
function isoParaBr(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || '');
  return m ? `${m[3]}/${m[2]}/${m[1]}` : '';
}

/** Escala com um motivo próprio, devolvendo o texto de DESCONHECIDO. */
async function escalaComo(
  groupFolder: string,
  tabela: Tabela,
  motivo: string,
  pergunta: string,
  deps: EscalationSlaDeps,
): Promise<SaidaDoExecutor> {
  const r = renderiza(tabela, 'DESCONHECIDO', { confianca: 1, slots: {} });
  const codigo = await escala(
    { folder: groupFolder, motivo, pergunta, urgente: false },
    deps,
  );
  return { texto: r.texto, intencao: 'DESCONHECIDO', acao: 'escalar', codigo };
}

export interface SaidaDoExecutor {
  /** O que enviar ao paciente. Vazio só se a tabela não tiver texto algum. */
  texto: string;
  intencao: string;
  acao: Resultado['acao'];
  /** Código do caso, quando escalou. */
  codigo?: string;
}

/**
 * Traduz a saída do modelo em texto aprovado, e age quando a ação é escalar.
 *
 * `bruto` é a saída crua do agente, não a limpa: o JSON pode vir cercado de
 * ruído, e é o parser que decide o que é válido.
 */
export async function executa(
  groupFolder: string,
  bruto: string,
  perguntaDoPaciente: string,
  deps: EscalationSlaDeps,
  chatJid: string,
  /**
   * JID de quem ESCREVEU a última mensagem. Em DM é o mesmo que `chatJid`; em
   * grupo, não — e é dele que sai o telefone do paciente. Passar o `chatJid` de
   * um grupo mandava o id do grupo como telefone.
   */
  remetenteJid = '',
): Promise<SaidaDoExecutor | undefined> {
  const tabela = carregaTabela(groupFolder);
  if (!tabela) {
    // Sem tabela não há como responder por template, e improvisar seria
    // exatamente o que esta arquitetura evita.
    logger.error(
      { groupFolder },
      'executor: templates.json ausente ou inválido',
    );
    return undefined;
  }

  const c = interpreta(bruto, tabela);
  if (c.rebaixou) {
    logger.warn(
      { groupFolder, motivo: c.rebaixou },
      'executor: saída do modelo rebaixada para DESCONHECIDO',
    );
  }

  // `dia` e `hora` não vêm do modelo, por proibição do parser. Então quando a
  // intenção exige esses slots, é o host que vai à agenda — senão o
  // renderizador rebaixa por slot ausente e NENHUMA oferta de horário seria
  // possível, que era o estado da primeira versão deste arquivo.
  let slots = c.slots;
  let ofertaAOferecer: Omit<OfertaPendente, 'quando'> | undefined;
  const exige = tabela.intencoes[c.intencao]?.slots_obrigatorios ?? [];
  if (exige.includes('dia') || exige.includes('hora')) {
    const perfil = perfilDe(c.slots.necessidade, c.slots.convenio);
    if (perfil && soHumano(perfil)) {
      // Retorno e exame a Lara não agenda (regra do Thiago, 06/10/2026). Escala
      // ANTES de ir à agenda: consultar vaga aqui gastaria 18s para descobrir um
      // horário que ela não pode oferecer.
      logger.info(
        { groupFolder, intencao: c.intencao, perfil },
        'executor: perfil só humano, escala sem consultar a agenda',
      );
      return await escalaComo(
        groupFolder,
        tabela,
        `pedido de ${perfil.startsWith('retorno') ? 'RETORNO' : 'EXAME'}: a Lara não agenda esses dois; veja o que foi solicitado na consulta anterior e responda ao paciente`,
        perguntaDoPaciente,
        deps,
      );
    }
    if (!perfil) {
      // "Não rode no chute" (F12): perfil errado é vaga inválida já prometida.
      logger.info(
        { groupFolder, intencao: c.intencao, slots: c.slots },
        'executor: sem perfil para a agenda, vai escalar',
      );
    } else {
      const vagas = await buscaVagas(groupFolder, perfil, {
        dia: diaIso(c.slots.dia_pedido),
      });
      if (vagas.length > 0) {
        slots = { ...slots, ...slotsDaVaga(vagas[0]) };
        // Guardada para registrar DEPOIS, se o texto realmente for produzido.
        // Registrar aqui gravaria uma oferta que o paciente pode nunca ver —
        // o render ainda pode rebaixar — e aí um "pode ser" marcaria um
        // horário que ele não viu, que é a falha que este módulo impede.
        // Guarda também QUEM é o paciente: no turno do aceite ("pode ser") os
        // slots vêm vazios, e sem isto a marcação recusa por dado faltando.
        ofertaAOferecer = {
          vaga: vagas[0],
          perfil,
          nome: c.slots.nome,
          nascimento: c.slots.nascimento,
          convenio: c.slots.convenio,
        };
      }
    }
  }

  // Aceite de horário: os valores vêm da oferta que o HOST registrou, e entram
  // em `slots` ANTES de renderizar. A primeira versão preenchia depois, com um
  // segundo substituidor — e o `preenche` original, que é a trava contra texto
  // com chave aberta, disparava antes e rebaixava o turno. O caminho inteiro
  // era inalcançável, e nenhum teste cobria.
  const vaiMarcar = tabela.intencoes[c.intencao]?.acao === 'marcar';
  const oferta = vaiMarcar ? ultimaOferta(groupFolder, chatJid) : undefined;
  // O caminho acima impede a oferta de nascer para retorno/exame, então isto é
  // rede: oferta gravada antes da regra, ou perfil que passe a existir depois.
  if (oferta && soHumano(oferta.perfil)) {
    logger.warn(
      { groupFolder, perfil: oferta.perfil },
      'executor: aceite de oferta só humana, não marca',
    );
    return await escalaComo(
      groupFolder,
      tabela,
      `aceitou um horário de ${oferta.perfil}, que a Lara não marca; confirme com o paciente`,
      perguntaDoPaciente,
      deps,
    );
  }
  if (vaiMarcar && oferta) {
    slots = {
      ...slots,
      ...slotsDaVaga(oferta.vaga),
      paciente: (oferta.nome ?? c.slots.nome ?? '').split(/\s+/)[0] ?? '',
    };
  }

  // O desconto decide sobre o que a CONVERSA disse, não só sobre este turno:
  // "e quanto fica a consulta?" não repete necessidade nem convênio, e sem
  // isto a regra avalia falso e o paciente ouve o preço cheio (07/10/2026).
  lembraSlots(groupFolder, chatJid, c.slots);
  const intencaoFinal = comDesconto(
    c.intencao,
    comLembrados(groupFolder, chatJid, slots),
    tabela,
  );
  const r = renderiza(tabela, intencaoFinal, {
    confianca: c.confianca,
    slots,
  });

  // O texto do desconto já recusa o convênio, mas a ação dele é `responder` e
  // isso perderia o pedido dos dados que faltam. Quando o desconto substitui a
  // recusa, mantemos a emenda: o F04 manda não gastar um turno só recusando.
  const acao =
    intencaoFinal !== c.intencao && c.intencao === 'convenio_nao_atendido'
      ? ('recusar_e_triagem' as Resultado['acao'])
      : r.acao;

  // Triagem: pedir só o que falta. O texto da tabela é o formulário de quatro
  // tópicos, que só serve a quem não deu nada ainda; com qualquer dado na mão a
  // frase vira corrida. Pedir de novo o que a pessoa acabou de responder é o
  // jeito mais rápido de parecer máquina.
  let texto = r.texto;
  // A pessoa respondeu de quem é a consulta.
  //
  // `paciente_confirmado`: os dados vêm do CADASTRO, não do que ela digitou, e
  // guardamos o id para a marcação ir com `--paciente-id`. Sem isso a
  // conferência de três fatores do script compararia o cadastro consigo mesmo.
  //
  // `paciente_outro`: esquece os candidatos. O cadastro do titular não serve
  // para a filha, e deixá-lo na memória faria a próxima pergunta errar de novo.
  if (c.intencao === 'paciente_confirmado' || c.intencao === 'paciente_outro') {
    const { candidatos } = candidatosLembrados(groupFolder, chatJid);
    if (c.intencao === 'paciente_confirmado' && candidatos[0]) {
      const cad = candidatos[0];
      lembraPacienteConfirmado(groupFolder, chatJid, cad.id);
      slots = {
        ...slots,
        nome: slots.nome?.trim() || cad.nome,
        nascimento: slots.nascimento?.trim() || isoParaBr(cad.nascimento),
      };
    } else {
      lembraCandidatos(groupFolder, chatJid, []);
    }
  }

  // Antes de pedir os quatro dados: a clínica já conhece este telefone?
  //
  // Trocar o formulário por UMA pergunta é o conserto do "parecer máquina"
  // (Thiago, 04/10/2026). O host NUNCA decide quem é — telefone identifica uma
  // casa, não uma pessoa (medido: um número devolve pai e filha). Ele nomeia o
  // candidato mais velho, que tende a ser o titular, e a pessoa confirma.
  if (
    acao === 'triagem' &&
    !slots.nome?.trim() &&
    tabela.intencoes.confirma_paciente &&
    !jaPerguntouPaciente(groupFolder, chatJid)
  ) {
    const tel = telefoneDoJid(remetenteJid || chatJid);
    const mem = candidatosLembrados(groupFolder, chatJid);
    let candidatos = mem.candidatos;
    if (tel && !mem.buscou) {
      candidatos = await pacientesComTelefone(groupFolder, tel);
      lembraCandidatos(groupFolder, chatJid, candidatos);
    }
    if (candidatos.length > 0) {
      const rc = renderiza(tabela, 'confirma_paciente', {
        confianca: 1,
        slots: { ...slots, paciente: primeiroNome(candidatos[0].nome) },
      });
      if (rc.texto) {
        marcaPerguntouPaciente(groupFolder, chatJid);
        return {
          texto: rc.texto,
          intencao: 'confirma_paciente',
          acao: 'responder',
        };
      }
    }
  }

  if (acao === 'triagem' || acao === 'recusar_e_triagem') {
    const formulario = tabela.intencoes.triagem_dados?.textos?.[0] ?? r.texto;
    let pedido = fraseDeTriagem(slots, { textoCompleto: formulario });

    // Os quatro dados completos e ainda assim triagem: o que falta é a
    // NECESSIDADE, que não é um dos quatro campos, e quem pergunta isso é o
    // menu da abertura.
    //
    // Antes, `pedido` vinha vazio e o fallback era `r.texto` — o formulário
    // INTEIRO. Na passada 6 (E08) o paciente mandou nome, nascimento, cidade e
    // convênio numa tacada e levou os quatro de volta; nenhuma oferta saiu, e o
    // "pode ser esse horário" seguinte escalou por falta de oferta. O comentário
    // da própria `fraseDeTriagem` já avisava que string vazia significa "não há
    // pergunta a fazer", e era justamente aí que se repetia tudo.
    // Só no caminho de TRIAGEM. Na recusa não: já existe decisão de que, com
    // tudo preenchido, a recusa não pendura pergunta no fim, e emendar o menu
    // ali seria desfazê-la de passagem.
    if (acao === 'triagem' && !pedido && !slots.necessidade?.trim()) {
      pedido = tabela.intencoes.abertura?.textos?.[0] ?? '';
    }

    if (acao === 'triagem') {
      if (!pedido) {
        // Nada a perguntar e ainda assim triagem: é rótulo errado. Escalar é
        // melhor que repetir formulário ou adivinhar o que ele quer.
        return await escalaComo(
          groupFolder,
          tabela,
          'triagem sem nada a perguntar: os quatro dados e a necessidade já vieram; veja o que o paciente quer',
          perguntaDoPaciente,
          deps,
        );
      }
      texto = pedido;
    } else {
      // A recusa vem primeiro e o pedido emenda, na mesma mensagem: o F04
      // manda não gastar um turno só perguntando. Sem nada faltando, só a
      // recusa, sem pergunta pendurada no fim.
      texto = [r.texto, pedido].filter(Boolean).join('\n\n');
    }
  }

  // Marcação: o paciente aceitou o horário que o HOST ofereceu e registrou.
  // O modelo não participa disto — ele só disse "ele aceitou".
  if (acao === 'marcar') {
    if (!oferta) {
      // Sem oferta registrada (ou vencida) não há o que marcar, e marcar "o
      // próximo livre" seria marcar algo que o paciente não viu.
      return await escalaComo(
        groupFolder,
        tabela,
        'aceitou um horário, mas não há oferta registrada ou ela venceu; confirme com o paciente',
        perguntaDoPaciente,
        deps,
      );
    }
    const res = await marca(groupFolder, {
      operacao: 'marcar',
      // A oferta vem primeiro: ela carrega o que foi coletado na triagem. O
      // turno do aceite normalmente não repete nome nem nascimento.
      paciente: oferta.nome || c.slots.nome || '',
      pedidoPor: remetenteJid || chatJid,
      nascimento: oferta.nascimento ?? c.slots.nascimento,
      convenio: oferta.convenio ?? c.slots.convenio,
      data: oferta.vaga.data,
      hora: oferta.vaga.inicio,
      perfil: oferta.perfil,
      pacienteId: pacienteConfirmado(groupFolder, chatJid),
    });
    if (!res.ok) {
      logger.warn(
        { groupFolder, motivo: res.motivo, detalhe: res.detalhe },
        'executor: marcação recusada, vai escalar',
      );
      return await escalaComo(
        groupFolder,
        tabela,
        `${r.motivoEscalada ?? 'marcação não saiu'} | ${res.motivo}: ${res.detalhe}`,
        perguntaDoPaciente,
        deps,
      );
    }
    // Some com a oferta: um "sim" repetido não deve marcar de novo. A
    // idempotência de `marca()` já cobriria, mas duas travas custam nada.
    esqueceOferta(groupFolder, chatJid);
  }

  // Só agora, com o texto da oferta de fato produzido, o host registra o que
  // ofereceu.
  if (ofertaAOferecer && acao === 'responder') {
    registraOferta(groupFolder, chatJid, ofertaAOferecer);
  }

  const saida: SaidaDoExecutor = {
    texto,
    intencao: r.intencao,
    acao,
  };

  if (acao === 'escalar') {
    saida.codigo = await escala(
      {
        folder: groupFolder,
        // O motivo da TABELA vem primeiro: é texto aprovado por humano e é ele
        // que enquadra o caso para quem atende. A observação do modelo entra
        // como detalhe, nunca no lugar do enquadramento.
        motivo:
          [r.motivoEscalada, c.observacao].filter(Boolean).join(' | ') ||
          `intenção ${r.intencao}`,
        pergunta: perguntaDoPaciente,
        urgente: r.urgente,
      },
      deps,
    );
  }

  logger.info(
    {
      groupFolder,
      intencao: r.intencao,
      // Quando o host trocou a intenção (desconto), o log tem de mostrar as
      // duas: a que o modelo deu e a que o paciente recebeu.
      intencaoDoModelo: c.intencao !== r.intencao ? c.intencao : undefined,
      acao,
      confianca: c.confianca,
      codigo: saida.codigo,
    },
    'executor: respondeu por template',
  );
  return saida;
}
