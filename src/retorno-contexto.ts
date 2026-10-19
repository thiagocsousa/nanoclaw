/**
 * O que a recepção precisa saber quando um retorno escala.
 *
 * Decisão do Thiago em 19/10/2026. O retorno de 30 dias costuma ser marcado na
 * própria consulta, mas há quem não queira na hora e volte pelo WhatsApp depois
 * — então o caso existe, e a Lara não agenda.
 *
 * ⚠️ E não agenda por um motivo que a data NÃO resolve: o FAQ diz "retorno em
 * até 30 dias, **se necessário** … se for preciso complementar a avaliação". O
 * retorno é gratuito quando termina a MESMA avaliação. Alguém dentro dos 30
 * dias com queixa NOVA é consulta, não retorno — e marcar como retorno dá
 * consulta de graça e meia hora errada na agenda. Quem sabe qual é só descobre
 * perguntando, e por isso escala mesmo com volume.
 *
 * O que dá para fazer sem mexer nessa decisão é chegar com a resposta pronta:
 * hoje a recepção recebe "quer marcar retorno" e vai procurar no iClinic.
 */

/** `2026-10-02` -> `02/10/2026`. */
function br(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || '');
  return m ? `${m[3]}/${m[2]}/${m[1]}` : iso;
}

function diasDesde(iso: string, agora: Date): number | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || '');
  if (!m) return undefined;
  const d = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const hoje = Date.UTC(
    agora.getUTCFullYear(),
    agora.getUTCMonth(),
    agora.getUTCDate(),
  );
  return Math.floor((hoje - d) / 86_400_000);
}

/**
 * Uma linha por cadastro com este telefone, dizendo quando foi a última
 * consulta e se ainda está dentro dos 30 dias.
 *
 * Devolve string vazia quando não há nada útil a dizer — e aí o escalonamento
 * sai como sempre saiu, sem inventar contexto.
 */
export function contextoDoRetorno(
  candidatos: Array<{ nome: string; ultima_consulta?: string }>,
  agora: Date = new Date(),
): string {
  if (candidatos.length === 0) {
    // Dizer isto é útil: telefone fora do cadastro raramente é retorno de
    // verdade, e a recepção já começa desconfiando.
    return 'este telefone não tem cadastro no iClinic';
  }
  const linhas = candidatos
    .map((c) => {
      const nome = (c.nome || '').trim();
      const iso = (c.ultima_consulta || '').trim();
      if (!iso) return `${nome}: sem consulta registrada`;
      const dias = diasDesde(iso, agora);
      if (dias === undefined) return `${nome}: última consulta ${br(iso)}`;
      const dentro = dias <= 30 ? 'dentro dos 30 dias' : 'fora dos 30 dias';
      const quando =
        dias === 0 ? 'hoje' : dias === 1 ? 'há 1 dia' : `há ${dias} dias`;
      return `${nome}: última consulta ${br(iso)}, ${quando}, ${dentro}`;
    })
    .filter(Boolean);
  return linhas.join(' | ');
}
