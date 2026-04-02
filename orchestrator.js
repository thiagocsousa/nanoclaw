import Anthropic from '@anthropic-ai/sdk';
import dotenv from 'dotenv';
import fs from 'fs';

dotenv.config();

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// função base
async function runAgent(agentName, input) {
  const prompt = fs.readFileSync(`./agents/${agentName}.txt`, 'utf-8');

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 1000,
    messages: [
      {
        role: "user",
        content: `${prompt}\n\nContexto:\n${input}`
      }
    ]
  });

  return response.content[0].text;
}

// pipeline completo
async function executarPipeline(dadosCampanha) {
  console.log("📊 Rodando análise...\n");

  const analise = await runAgent("analista", dadosCampanha);
  console.log("🔍 Análise:\n", analise);

  const estrategia = await runAgent("gestor", analise);
  console.log("\n🧠 Estratégia:\n", estrategia);

  const anuncios = await runAgent("copy", estrategia);
  console.log("\n✍️ Novos anúncios:\n", anuncios);

  return {
    analise,
    estrategia,
    anuncios
  };
}

// exemplo real
(async () => {
  const dados = `
Campanha: Cirurgia Refrativa
CTR: 1.1%
CPC: R$2,30
CPL: R$32
Leads: 15
Agendamentos: 2
`;

  await executarPipeline(dados);
})();
