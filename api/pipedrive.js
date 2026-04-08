// Vercel Serverless Function — Pipedrive API
// Chamada: GET /api/pipedrive?since=2026-01-01&until=2026-01-31

export default async function handler(req, res) {
  // Permite chamadas do próprio dashboard
  res.setHeader('Access-Control-Allow-Origin', '*');

  const { since, until } = req.query;
  const token = process.env.PIPEDRIVE_TOKEN;

  if (!token) {
    return res.status(500).json({ error: 'Token não configurado' });
  }

  // TODO: implementar chamadas reais ao Pipedrive
  // Por enquanto retorna estrutura esperada com dados mockados
  return res.status(200).json({
    source: 'pipedrive',
    period: { since, until },
    aplicacao: {
      leads: 318,
      mqls: 82,
      calls_agendadas: 54,
      calls_realizadas: 38,
      vendas: 12,
      receita: 77364
    },
    webinario: {
      leads: 1083,
      calls_agendadas: 74,
      calls_realizadas: 51,
      vendas: 18,
      receita: 55815
    },
    social_selling: {
      leads: 120,
      calls_agendadas: 31,
      calls_realizadas: 22,
      vendas: 7,
      receita: 16264
    }
  });
}
