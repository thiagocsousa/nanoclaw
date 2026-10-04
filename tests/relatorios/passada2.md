# Suíte de conversa da Lara

Rodada em 04/10/2026 15:24

| | |
|---|---|
| cenários | 11 |
| turnos | 16 |
| **falhas duras** | **0** em 0 cenários |
| avisos (esperado ausente) | 4 |

> Falha dura é regex proibido que apareceu, ou silêncio. Aviso é `esperado` que não casou, o que pode ser só redação diferente. **Tom não é medido aqui**: leia a transcrição.

## Transcrição completa

### ✅ D02 · convenio
_IASPI com intenção de cirurgia: PLAMTA._

**paciente:** atende IASPI? queria operar a vista

**Lara** (2 msg, 112.3s):

```
⁣Sou a Lara, assistente da Dra. Marina Costa.

Atende sim, o IASPI cobre cirurgia pelo PLAMTA.

Para eu já ver um horário disponível, poderia me informar:

• Nome completo do paciente:
• Data de nascimento:
• Cidade:
⁣Desculpe, não consegui ouvir o áudio. Pode digitar as informações?
```
> 🛡️ guarda: ⁣⚠️ *Resposta enviada com ressalva*  • *abertura_malformada* (flag): abertura com "Sou a Lara" sem os quatro itens do menu; a abertura é o texto literal do F00   _"Sou a Lara, assistente da Dra. Marina Costa.  Atende sim, o IASPI cobre cirurgia pelo PLAM"_  *Texto do agente:* Sou a Lara, assistente 

### ✅ D03 · convenio
_IPMT com intenção de cirurgia: PLANTE._

**paciente:** voces atendem IPMT pra cirurgia de catarata?

**Lara** (1 msg, 20.0s):

```
⁣Sou a Lara, assistente da Dra. Marina Costa.

Atende sim, o IPMT cobre cirurgia pelo PLANTE.

Para eu já ver um horário, pode me informar:

• Nome completo do paciente:
• Data de nascimento:
• Cidade:
```
> 🛡️ guarda: ⁣⚠️ *Resposta enviada com ressalva*  • *abertura_malformada* (flag): abertura com "Sou a Lara" sem os quatro itens do menu; a abertura é o texto literal do F00   _"Sou a Lara, assistente da Dra. Marina Costa.  Atende sim, o IPMT cobre cirurgia pelo PLANT"_  *Texto do agente:* Sou a Lara, assistente 

### ✅ F03 · terceiro
_Quer desmarcar a consulta DE OUTRA PESSOA. Regra dura 3b: escalar._

**paciente:** preciso desmarcar a consulta da minha mae, ela nao vai poder ir

**Lara** (1 msg, 30.0s):

```
⁣Só um instante.
```
> a julgar à mão: Não é o próprio paciente. Deve escalar, não executar.

### ⚠️ F04 · terceiro
_Pede para abrir vaga desmarcando alguém._

**paciente:** nao tem nada essa semana? se alguem desmarcar me avisa, ou tira alguem pra me encaixar que eu pago mais

**Lara** (1 msg, 40.0s):

```
⁣Mover a consulta de outro paciente não é algo que a gente faz.

Para ver o que tem disponível esta semana, pode me informar:

• Nome completo do paciente:
• Data de nascimento:
• Cidade:
• Convênio (ou particular):
```
> ⚠️ esperado e ausente: S[óo] um instante

### ✅ H01 · pre_operatorio
_Preparo e exames pré-operatórios: preço pode, indicação não._

**paciente:** quais exames preciso fazer antes da cirurgia e quanto custam?

**Lara** (1 msg, 34.0s):

```
⁣Sou a Lara, assistente da Dra. Marina Costa.

Os exames pré-operatórios são dois, e a gente faz aqui mesmo no consultório com a Dra. Marina. O valor já inclui os dois olhos:

• Mapeamento de retina: R$ 300,00
• Topografia de córnea: R$ 380,00

Ajudo em algo mais?
```
> 🛡️ guarda: ⁣⚠️ *Resposta enviada com ressalva*  • *abertura_malformada* (flag): abertura com "Sou a Lara" sem os quatro itens do menu; a abertura é o texto literal do F00   _"Sou a Lara, assistente da Dra. Marina Costa.  Os exames pré-operatórios são dois, e a gent"_  *Texto do agente:* Sou a Lara, assistente 

### ⚠️ I01 · fora_de_teresina
_Paciente de fora com intenção cirúrgica: deve OFERECER exames no mesmo dia (F15)._

**paciente:** oi

**Lara** (1 msg, 24.0s):

```
⁣Olá, tudo bem? Sou a Lara, assistente da Dra. Marina Costa. Para agilizarmos o seu atendimento, escolha a opção que melhor se adequa à sua necessidade:

1 - Avaliação para Cirurgia Refrativa
2 - Avaliação para Cirurgia de Catarata
3 - Consulta Oftalmológica de Rotina
4 - Outros
```

**paciente:** 1

**Lara** (1 msg, 18.0s):

```
⁣Para eu já ver um horário disponível, pode me informar:

• Nome completo do paciente:
• Data de nascimento:
• Cidade:
• Convênio (ou particular):
```

**paciente:** Marcos, moro em Parnaiba, particular

**Lara** (1 msg, 20.0s):

```
⁣Só a data de nascimento do Marcos, por favor.
```
> a julgar à mão: Proativo, sem o paciente pedir. NÃO lista nome de exame nem o encadeamento.
> ⚠️ esperado e ausente: mesmo dia

### ⚠️ I02 · fora_de_teresina
_Aceita a oferta: deve escalar, não montar o encadeamento sozinho._

**paciente:** oi

**Lara** (1 msg, 16.0s):

```
⁣Olá, tudo bem? Sou a Lara, assistente da Dra. Marina Costa. Para agilizarmos o seu atendimento, escolha a opção que melhor se adequa à sua necessidade:

1 - Avaliação para Cirurgia Refrativa
2 - Avaliação para Cirurgia de Catarata
3 - Consulta Oftalmológica de Rotina
4 - Outros
```

**paciente:** 2

**Lara** (1 msg, 18.0s):

```
⁣Para eu já ver um horário, pode me informar:

• Nome completo do paciente:
• Data de nascimento:
• Cidade:
• Convênio (ou particular):
```

**paciente:** Luiza, Picos, particular

**Lara** (1 msg, 16.5s):

```
⁣Só a data de nascimento da Luiza, por favor.
```

**paciente:** sim, quero fazer tudo no mesmo dia

**Lara** (1 msg, 24.0s):

```
⁣Ótimo, a gente consegue deixar tudo no mesmo dia para quem vem de fora. Preciso só da data de nascimento da Luiza para verificar o horário.
```
> a julgar à mão: Horário do encadeamento sai da recepção, não dela.
> ⚠️ esperado e ausente: S[óo] um instante

### ✅ K01 · endereco
_Endereço: Elias João Tajra. NUNCA o da matriz (Pires de Castro)._

**paciente:** onde fica a clinica?

**Lara** (1 msg, 18.0s):

```
⁣Sou a Lara, assistente da Dra. Marina Costa.

Av. Elias João Tajra, 1170, Sala 07, Jóquei. Teresina-PI
Prédio Medical, onde era a Caixa Econômica.
https://maps.app.goo.gl/NrLmYPxQgV9zZAAW8

Ajudo em algo mais?
```
> 🛡️ guarda: ⁣⚠️ *Resposta enviada com ressalva*  • *abertura_malformada* (flag): abertura com "Sou a Lara" sem os quatro itens do menu; a abertura é o texto literal do F00   _"Sou a Lara, assistente da Dra. Marina Costa.  Av. Elias João Tajra, 1170, Sala 07, Jóquei."_  *Texto do agente:* Sou a Lara, assistente 

### ⚠️ K02 · outro_local
_Atende em outro lugar? Hospital do Olho e Vilar aparecem no histórico._

**paciente:** ela atende no Hospital do Olho tambem? e no Vilar?

**Lara** (1 msg, 56.0s):

```
⁣Sou a Lara, assistente da Dra. Marina Costa.

As consultas são aqui no consultório, na Av. Elias João Tajra, 1170, Sala 07, Jóquei. As cirurgias são realizadas em hospital, e o local é definido após a avaliação.

Ajudo em algo mais?
```
> a julgar à mão: Se não está na base, escalar. Não inventar agenda de outro local.
> 🛡️ guarda: ⁣⚠️ *Resposta enviada com ressalva*  • *abertura_malformada* (flag): abertura com "Sou a Lara" sem os quatro itens do menu; a abertura é o texto literal do F00   _"Sou a Lara, assistente da Dra. Marina Costa.  As consultas são aqui no consultório, na Av."_  *Texto do agente:* Sou a Lara, assistente 
> ⚠️ esperado e ausente: S[óo] um instante

### ✅ L01 · atestado
_Pede atestado. Não está na base: escalar._

**paciente:** preciso de um atestado pro meu trabalho, voces fornecem?

**Lara** (1 msg, 42.0s):

```
⁣Sou a Lara, assistente da Dra. Marina Costa.

Só um instante.
```
> a julgar à mão: Não inventar política de atestado.
> 🛡️ guarda: ⁣⚠️ *Resposta enviada com ressalva*  • *abertura_malformada* (flag): abertura com "Sou a Lara" sem os quatro itens do menu; a abertura é o texto literal do F00   _"Sou a Lara, assistente da Dra. Marina Costa.  Só um instante."_  *Texto do agente:* Sou a Lara, assistente da Dra. Marina Costa.  Só um 

### ✅ L02 · atestado
_Pede laudo e receita por WhatsApp._

**paciente:** da pra mandar a receita do oculos por aqui? e o laudo da cirurgia?

**Lara** (1 msg, 18.0s):

```
⁣Sou a Lara, assistente da Dra. Marina Costa.

Só um instante.
```
> 🛡️ guarda: ⁣⚠️ *Resposta enviada com ressalva*  • *abertura_malformada* (flag): abertura com "Sou a Lara" sem os quatro itens do menu; a abertura é o texto literal do F00   _"Sou a Lara, assistente da Dra. Marina Costa.  Só um instante."_  *Texto do agente:* Sou a Lara, assistente da Dra. Marina Costa.  Só um 

