#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Marca uma consulta na agenda da Dra. Marina (Clínica nas Nuvens). ESCREVE.

## O que este script NÃO faz, e por quê

Não remarca e não cancela. Decisão do Thiago em 04/10/2026, pelo critério do que
o erro causa: marcar é **aditivo** — errar cria um horário a mais, que se apaga.
Remarcar e cancelar são destrutivos, e erram apagando ou movendo a consulta de
alguém que vai aparecer na clínica no dia. Esses dois escalam para a recepção.

## Era o iClinic, até 25/10/2026 — como o formato foi descoberto

Observando o formulário real em 05/10/2026, com o Thiago presente. O modal de
"Novo Agendamento" é um form Django **sem atributo `action`**, e form sem action
envia para a URL do documento. Mas a aplicação **intercepta o submit** e faz um
XHR para `POST /agenda/criar-evento/{PHYSICIAN_ID}/`: eu inferi `/agenda/` pela
regra do HTML e tomei 405 duas vezes. Os nomes dos campos e os ids vieram do DOM.

O corpo é **JSON**, não form-encoded, e a estrutura NÃO é a do formulário HTML:
`procedures` é array de `{procedure_id, quantity}` com números, não
`procedures[0][id]`. Medido em 05/10/2026 interceptando o XHR real.

**Paciente novo é criado no mesmo POST:** `patient: null` com `patient_name`
preenchido. Verificado com "Laura Teste", que não existia. Não há chamada
separada de cadastro, e o autocomplete aceita nome livre.

## A trava que substitui a confirmação humana

`--verificar` relê a agenda **antes** (a vaga está livre?) e **depois** (ficou
ocupada?). É isso que fecha a janela entre oferecer e marcar, onde mora a
colisão de dois pacientes no mesmo horário. Uma pessoa confirmando minutos
depois não fecharia essa janela.

Uso:
  iclinic_marcar.py --nome "Fulano de Tal" --data 2026-10-05 --inicio 11:30 \
      --fim 12:00 --perfil particular [--telefone 86999999999] [--dry-run]

Saída: texto legível + última linha JSON {"wakeAgent": false, "ok": bool, ...}.
"""
import argparse
import json
import os
import sys
from datetime import date, datetime

import cnn
EXECUTOR_PESSOA = int(os.environ.get("CNN_PESSOA_EXECUTOR", "29728769"))
LOCAL_AGENDA = int(os.environ.get("CNN_LOCAL_AGENDA", "49571"))

# ⛔ Os ids agora são da Clínica nas Nuvens, lidos da API em 24/10/2026
# (/tipo-convenio/lista e /tipo-consulta/lista), não mais da TELA do iClinic.
CONVENIOS = {
    "particular": 74466,
    "particular-desconto": 74543,
    "unimed": 74544,
    "iaspi": 74546,
    "ipmt": 74545,
}

# ⛔ O PERFIL mudou de eixo. No iClinic a distinção morava no PROCEDIMENTO
# ("CONSULTA PARTICULAR CIRURGIA"); na CNN há uma só consulta
# (1212102 CONSULTA OFTALMOLÓGICA) e a distinção vive em `idTipoConsulta`.
PROCEDIMENTO_CONSULTA = 1212102

CONVENIO_DO_PERFIL = {
    "particular": "particular",
    "particular-cirurgia": "particular",
    "particular-desconto": "particular-desconto",
    "unimed": "unimed",
    "unimed-cirurgia": "unimed",
}

# ⚠️ A LARA NÃO MARCA CIRURGIA (Thiago, 25/10/2026). O perfil `*-cirurgia` é
# consulta de AVALIAÇÃO cirúrgica — por isso o tipo é uma das três avaliações,
# e nunca 126578 CIRURGIA, que é o ato no centro cirúrgico.
TIPO_CONSULTA_SIMPLES = 126577          # CONSULTA
AVALIACAO_POR_NECESSIDADE = {
    "catarata": 126591,
    "cirurgia refrativa": 126592,
    "pterígio": 126593,
}


def tipo_de_consulta(perfil, necessidade):
    """`idTipoConsulta` do agendamento.

    ⚠️ Perfil cirúrgico com necessidade GENÉRICA ("cirurgia", sem dizer qual)
    cai na consulta simples, não escala. Sub-especificar é diferente de errar:
    a pessoa é atendida do mesmo jeito e a Marina vê "Consulta" em vez de
    "Avaliação cirúrgica – catarata". Escalar aqui custaria atendimento por um
    rótulo, e marcar uma avaliação chutada poria a coisa errada na agenda dela.
    """
    if not perfil.endswith("-cirurgia"):
        return TIPO_CONSULTA_SIMPLES
    return AVALIACAO_POR_NECESSIDADE.get(
        (necessidade or "").strip().lower(), TIPO_CONSULTA_SIMPLES)


def responder(linhas, **extra):
    for l in linhas:
        print(l)
    print(json.dumps({"wakeAgent": False, **extra}, ensure_ascii=False))


# ⛔ Aqui morava a correlação por NOME (`CHAVES_NOME`, `_nome_do_evento`,
# `_id_do_paciente`, `_so_letras`, `confere_paciente`) — ~64 linhas que liam
# `patient_name`, `patient__name` e `title`, campos do iClinic que a CNN não
# devolve. A verificação pós-escrita passou a casar por `idPaciente`, que é
# exato, e o cluster ficou sem nenhum chamador de produção.
#
# ⚠️ O único que sobrava era `scripts/checar-marcacao.py`, que alimentava
# `confere_paciente` com eventos no formato iClinic e imprimia "11 casos, 0
# falhas". Um verde sobre zero linha viva, justamente na trava que o arquivo
# chama de "a última coisa entre 'Marcado' e um paciente indo à clínica sem
# horário". Pior que não ter teste: ter um que tranquiliza.

def eventos_do_dia(ds):
    """Eventos da agenda num dia. Usado para verificar antes e depois."""
    return cnn.agenda(ds, ds)


def _vagas():
    """Importa a aritmética de agenda do iclinic_vagas.py, que é a fonte única.

    Os dois scripts moram na mesma pasta montada em /workspace/group/scripts/,
    então o import é local e não precisa de pacote.

    Reimplementar isto aqui já custou caro: a primeira versão comparava
    `ev["date"][11:16]` com a hora, mas `date` é só AAAA-MM-DD e a hora vive em
    `start_time` — a função nunca devolvia True, e com ela nem a checagem de
    vaga livre nem a de "foi criado?" detectavam coisa alguma. Pior, uma
    comparação ingênua de igualdade ainda erraria três casos que a lógica real
    trata: consulta CANCELADA libera o horário, "SOLICITAÇÕES" não ocupa sala, e
    um compromisso de 20 min às 09:10 invade as 09:20.
    """
    for d in (os.path.dirname(os.path.abspath(__file__)),
              "/workspace/group/scripts"):
        if d and d not in sys.path:
            sys.path.insert(0, d)
    try:
        import iclinic_vagas as v
    except ImportError as exc:
        # Sem a aritmética de agenda não há verificação de vaga, e sem ela este
        # script não tem o direito de escrever. Morrer aqui é o certo.
        raise SystemExit(
            "iclinic_vagas.py não encontrado ao lado deste script: sem ele não "
            "há como conferir se a vaga está livre. Não marquei. (%s)" % exc)
    return v


def livre_para(ds, inicio, perfil):
    """O horário está na GRADE da CNN para este dia?

    ⛔ Pergunta à mesma fonte que a oferta (`/executor-agenda/disponibilidade`),
    e não à ocupação inferida dos eventos.

    Antes isto derivava "livre" de `ocupacao(eventos)` + um `travado` que a
    migração removeu. Além do ValueError que isso causava, havia o buraco de
    desenho: cirurgia não ocupa sala de consulta, então a TERÇA — dia de
    cirurgia, bloqueado na agenda — parecia livre para este caminho, e a
    marcação escreveria nela.

    ⛔ E desde 26/10/2026 a grade da CNN **não basta**: ela ficou aberta de
    propósito, para a secretária marcar exame e cirurgia nos outros dias. Então
    aqui vale a MESMA interseção da oferta (`v.intersecta` com
    `v.janela_do_dia`) — senão a Lara ofereceria dentro da janela e MARCARIA
    fora, que é o pior dos dois mundos: o gate da oferta existe e o da escrita
    não. Reusa as funções do `iclinic_vagas`, não reimplementa: duas versões da
    mesma regra divergem, e esta é a que grava.
    """
    v = _vagas()
    tipo, _ = v.PERFIS[perfil]
    dur = v.DURACOES[tipo]
    bruta = cnn.disponibilidade(v.EXECUTOR_AGENDA, ds, ds).get(ds, [])
    dia = date.fromisoformat(ds)
    grade = v.intersecta(
        [(v.hm(a), v.hm(b)) for a, b in bruta], v.janela_do_dia(dia)
    )
    alvo = v.hm(inicio)
    return any(a == alvo and b - a >= dur for a, b in grade)


def ids_de(eventos):
    """Conjunto dos ids dos eventos. É assim que se prova o que ESTE POST criou."""
    return {str(e.get("id")) for e in eventos if e.get("id") is not None}



def so_digitos(x):
    return "".join(c for c in (x or "") if c.isdigit())


def iso_nascimento(x):
    """Normaliza a data para AAAA-MM-DD.

    A triagem coleta como o paciente escreve ("10/03/1980") e a API devolve
    "1980-03-10". Comparar sem normalizar não casaria NUNCA, e o efeito seria
    invisível: todo paciente existente pareceria novo, e o script duplicaria
    cadastro achando que estava sendo cuidadoso.
    """
    d = so_digitos(x)
    if len(d) != 8:
        return ""
    if (x or "").strip()[:4].isdigit():      # já veio AAAA-MM-DD
        return f"{d[0:4]}-{d[4:6]}-{d[6:8]}"
    return f"{d[4:8]}-{d[2:4]}-{d[0:2]}"     # DD/MM/AAAA


def busca_paciente(nome, nascimento, telefone):
    """Acha o paciente existente. Devolve (id, motivo).

    `id` None com motivo "novo" significa que não existe e pode ser cadastrado.
    Qualquer outro motivo com `id` None significa PARE: escalar.

    Por que existe: sem busca, todo agendamento ia com `patient: null` e criava
    um cadastro NOVO — um paciente de dez anos de casa ganharia um segundo
    registro, e o prontuário dele ficaria partido em dois. Isso é poluição
    durável de prontuário, não um deslize de mensagem.

    ## A regra: nome MAIS nascimento E telefone (Thiago, 05/10/2026)

    Os dois fatores juntos, não um OU outro. Com "ou", um homônimo cujo telefone
    a clínica não tem, mas cuja data de nascimento coincida, seria tratado como
    a mesma pessoa — e aí o agendamento entra no prontuário de outra gente.

    Faltando qualquer um dos dois fatores, ou batendo só um, o script NÃO decide:
    escala. Um humano resolve isso em segundos olhando a ficha; o script errando
    cria um estrago que ninguém desfaz.
    """
    try:
        achados = cnn._paginado(
            "/paciente/lista", nomeContem=nome, somenteAtivos="false")
    except cnn.CnnIndisponivel as exc:
        return None, f"busca de paciente falhou ({exc})"
    if not achados:
        return None, "novo"          # ninguém com esse nome: cadastrar é seguro

    nasc = iso_nascimento(nascimento)
    tel = so_digitos(telefone)[-8:]  # sufixo: 9º dígito e DDI variam, o final não
    if not nasc or not tel:
        return None, ("ha cadastro com esse nome e falta "
                      + ("nascimento" if not nasc else "telefone")
                      + " para confirmar que e a mesma pessoa")

    def _tel(p):
        c = p.get("contato") or {}
        return [c.get("telefoneCelular"), c.get("telefoneResidencial"),
                c.get("telefoneComercial")]

    def _bate_tel(p):
        return any(so_digitos(x).endswith(tel) for x in _tel(p) if x)

    def _bate_nasc(p):
        return iso_nascimento(p.get("dataNascimento")) == nasc

    exatos = [p for p in achados if _bate_nasc(p) and _bate_tel(p)]
    if len(exatos) == 1:
        if not exatos[0].get("ativo"):
            return None, "cadastro inativo na Clinica nas Nuvens"
        return exatos[0].get("id"), "existente"
    if len(exatos) > 1:
        return None, "mais de um cadastro com o mesmo nome, nascimento e telefone"

    parcial = [p for p in achados if _bate_nasc(p) or _bate_tel(p)]
    if parcial:
        return None, ("ha cadastro com esse nome em que so o "
                      + ("nascimento" if _bate_nasc(parcial[0]) else "telefone")
                      + " confere")
    return None, "ha cadastro com esse nome e nenhum dado confere"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--nome", required=True)
    ap.add_argument("--paciente-id", default=None,
                    help="id do paciente. Omitido, o script BUSCA antes de criar.")
    ap.add_argument("--nascimento", default="",
                    help="AAAA-MM-DD. Segundo fator para casar o paciente existente.")
    ap.add_argument("--data", required=True, help="ISO: 2026-10-05")
    ap.add_argument("--inicio", required=True, help="HH:MM")
    ap.add_argument("--fim", required=True, help="HH:MM")
    ap.add_argument("--perfil", required=True,
                    choices=sorted(CONVENIO_DO_PERFIL))
    # ⚠️ Novo na migração para a CNN: `idTipoConsulta` precisa saber QUAL
    # avaliação cirúrgica. A triagem já extrai (catarata / cirurgia refrativa /
    # pterígio); vazio ou genérico cai na consulta simples.
    ap.add_argument("--necessidade", default="")
    ap.add_argument("--telefone", default="")
    ap.add_argument("--email", default="")
    ap.add_argument("--observacao", default="")
    ap.add_argument("--dry-run", action="store_true",
                    help="valida e mostra o que enviaria, sem escrever")
    a = ap.parse_args()

    try:
        d = date.fromisoformat(a.data)
        datetime.strptime(a.inicio, "%H:%M")
        datetime.strptime(a.fim, "%H:%M")
    except ValueError as exc:
        responder([f"Entrada inválida: {exc}"], ok=False, erro="entrada_invalida")
        return 2

    convenio = CONVENIOS[CONVENIO_DO_PERFIL[a.perfil]]
    tipo_consulta = tipo_de_consulta(a.perfil, a.necessidade)
    # Formato de `POST /agenda/novo`, do Swagger da CNN. `idPaciente` e
    # `idPacienteConvenio` são OBRIGATÓRIOS — ao contrário do iClinic, onde
    # `patient: null` criava o cadastro junto. Por isso o fluxo virou três
    # escritas, e por isso a busca de paciente acontece ANTES.
    campos = {
        "data": d.isoformat(),
        "horaInicio": f"{a.inicio}:00",
        "horaFim": f"{a.fim}:00",
        "idLocalAgenda": LOCAL_AGENDA,
        "idPessoaExecutor": EXECUTOR_PESSOA,
        "idTipoConsulta": tipo_consulta,
        "status": "AGENDADO",
        "telefoneCelularPaciente": a.telefone or None,
        "emailPaciente": a.email or None,
        "observacoes": a.observacao or None,
        "procedimentos": [
            {"idTipoProcedimento": PROCEDIMENTO_CONSULTA, "quantidade": 1}
        ],
        # ⛔ As três notificações DESLIGADAS, sempre. A CNN manda WhatsApp/SMS
        # sozinha se pedirem, e aí o paciente receberia o lembrete dela E o
        # nosso — duas mensagens para a mesma consulta, e a nossa supressão de
        # resposta a pipeline não reconhece a deles (Thiago, 24/10/2026).
        "notificarWhatsappPaciente": False,
        "notificarSMSPaciente": False,
        "notificarEmailPaciente": False,
    }

    if a.dry_run:
        mostrar = dict(campos)
        mostrar["telefoneCelularPaciente"] = "<telefone>" if a.telefone else None
        responder(["Dry-run: nada foi escrito.", "",
                   "Enviaria para POST /agenda/novo:"] +
                  [f"   {k} = {v}" for k, v in mostrar.items()],
                  ok=None, dry_run=True)
        return 0

    try:
        antes = eventos_do_dia(a.data)
    except cnn.CnnIndisponivel as exc:
        responder([f"Não consegui ler a agenda antes de marcar: {exc}",
                   "Não marquei."], ok=False, erro="agenda_ilegivel")
        return 1
    if not livre_para(a.data, a.inicio, a.perfil):
        responder([f"{a.inicio} de {a.data} não está livre. Não marquei."],
                  ok=False, erro="horario_ocupado")
        return 1
    ids_antes = ids_de(antes)

    # ── identidade ────────────────────────────────────────────────────────
    pid = int(a.paciente_id) if a.paciente_id else None
    if pid is None:
        pid, motivo = busca_paciente(a.nome, a.nascimento, a.telefone)
        if pid is None and motivo != "novo":
            responder([f"Não marquei: {motivo}.",
                       "Confira a ficha e marque à mão."],
                      ok=False, erro="identidade_incerta", motivo=motivo)
            return 1

    # ⛔ TRÊS ESCRITAS SEM TRANSAÇÃO (paciente → convênio → agenda).
    #
    # No iClinic era UMA: `patient: null` criava o cadastro junto do evento. Na
    # CNN `idPaciente` e `idPacienteConvenio` são obrigatórios, então falhar no
    # meio deixa paciente criado sem consulta — e repetir a primeira duplica
    # cadastro, que é poluição durável de prontuário.
    #
    # A reentrância é a `busca_paciente` acima: ela roda SEMPRE antes, então uma
    # segunda tentativa encontra o cadastro da primeira em vez de criar outro.
    try:
        if pid is None:
            novo_pac = cnn.posta("/paciente/novo", {
                "nome": a.nome,
                "dataNascimento": iso_nascimento(a.nascimento) or None,
                "contato": {"telefoneCelular": a.telefone or None,
                            "email": a.email or None},
            })
            pid = novo_pac.get("id")
            if not pid:
                responder(["A CNN não devolveu id ao criar o paciente.",
                           "ESTADO INCERTO: confira antes de tentar de novo."],
                          ok=False, erro="paciente_sem_id")
                return 1

        id_convenio = cnn.convenio_do_paciente(pid, convenio)
        if not id_convenio:
            responder([f"Não consegui associar o convênio ao paciente {pid}.",
                       "Não marquei."], ok=False, erro="convenio_nao_associado")
            return 1

        campos["idPaciente"] = pid
        campos["idPacienteConvenio"] = id_convenio
        criado = cnn.posta("/agenda/novo", campos)
    except cnn.CnnIndisponivel as exc:
        responder([f"Falha ao marcar: {exc}",
                   "ESTADO INCERTO: confira a agenda antes de tentar de novo."],
                  ok=False, erro="falha_na_escrita")
        return 1

    # ── a prova: releitura ────────────────────────────────────────────────
    #
    # O POST devolver 200 não prova que o evento ficou na agenda. Quem prova é
    # reler e achar um evento NOVO, no horário pedido, do NOSSO paciente.
    try:
        depois = eventos_do_dia(a.data)
    except cnn.CnnIndisponivel as exc:
        responder([f"Marquei (id {criado.get('id')}), mas não consegui reler: {exc}",
                   "ESTADO INCERTO: confira à mão antes de tentar de novo."],
                  ok=None, erro="releitura_falhou")
        return 1

    novos = [e for e in depois if str(e.get("id")) not in ids_antes]
    meu = [e for e in novos
           if (e.get("horaInicio") or "")[:5] == a.inicio
           and e.get("idPaciente") == pid]
    if not meu:
        responder([f"A CNN aceitou (id {criado.get('id')}), mas a releitura não "
                   f"achou o evento às {a.inicio} para este paciente.",
                   "ESTADO INCERTO: confira à mão antes de tentar de novo."],
                  ok=None, erro="nao_confirmado")
        return 1

    responder([f"Marcado: {a.data} às {a.inicio}.",
               f"   paciente {pid} · tipo {tipo_consulta} · convênio {convenio}"],
              ok=True, evento_id=meu[0].get("id"), paciente_id=pid,
              data=a.data, inicio=a.inicio)
    return 0

if __name__ == "__main__":
    sys.exit(main())
