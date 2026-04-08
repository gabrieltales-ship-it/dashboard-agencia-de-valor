// Vercel Serverless Function — Meta Ads API
// Chamada: GET /api/meta?since=2026-01-01&until=2026-01-31
// Conectar por último — estrutura preparada

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const { since, until } = req.query;
  const token = process.env.META_TOKEN;
  const adAccountId = process.env.META_AD_ACCOUNT_ID; // formato: act_XXXXXXXXX

  if (!token || !adAccountId) {
    return res.status(500).json({ error: 'Credenciais Meta não configuradas' });
  }

  // TODO: implementar chamadas reais à Meta Marketing API
  // Filtros de campanha por nome:
  //   Aplicação  → contém "Sessão"
  //   Webinário  → contém "Web"
  //   Social SS  → contém "Tráfego"
  // Status: apenas ACTIVE e IN_PROCESS
  return res.status(200).json({
    source: 'meta_ads',
    period: { since, until },
    aplicacao:     { spend: 18420, leads: 342, mqls: 87 },
    webinario:     { spend: 9150,  leads: 1247 },
    social_selling:{ spend: 4280,  seguidores: 2841 }
  });
}
