// Vercel Serverless Function — Meta Ads API (Marketing API v21.0)
// Chamada: GET /api/meta?since=2026-01-01&until=2026-01-31
//
// Filtros de campanha por nome:
//   Aplicação      → contém "Sessão"
//   Webinário      → contém "Web"
//   Social Selling → contém "Tráfego"
//
// Eventos rastreados:
//   Leads      → action_type: "lead"  (evento nativo Meta)
//   MQLs       → action_type: "offsite_conversion.custom.MQL"
//   Seguidores → action_type: "onsite_conversion.follow" + "page_fan_adds"

const BASE = 'https://graph.facebook.com/v21.0';

// ─── Helper: percorre todas as páginas de paginação cursor ───────────────────

async function fetchAllPages(url) {
  let results = [];
  let nextUrl = url;

  while (nextUrl) {
    const res  = await fetch(nextUrl);
    const json = await res.json();
    if (json.error) throw new Error(`Meta API: ${json.error.message} (code ${json.error.code})`);
    results = results.concat(json.data || []);
    nextUrl  = json.paging?.next || null;
  }

  return results;
}

// ─── Helper: soma valores de action_types específicos ────────────────────────

function sumActions(actions, ...types) {
  if (!actions) return 0;
  return actions
    .filter(a => types.includes(a.action_type))
    .reduce((sum, a) => sum + (parseInt(a.value, 10) || 0), 0);
}

// ─── Busca insights agregados para uma lista de campaign IDs ─────────────────

async function getFunnelInsights(adAccountId, campaignIds, since, until, token) {
  if (campaignIds.length === 0) {
    return { spend: 0, leads: 0, mqls: 0, seguidores: 0, campaigns: [] };
  }

  const timeRange = JSON.stringify({ since, until });
  const filtering = JSON.stringify([
    { field: 'campaign.id', operator: 'IN', value: campaignIds }
  ]);
  const fields = 'campaign_id,campaign_name,spend,actions';

  const url = `${BASE}/${adAccountId}/insights`
    + `?level=campaign`
    + `&fields=${encodeURIComponent(fields)}`
    + `&time_range=${encodeURIComponent(timeRange)}`
    + `&filtering=${encodeURIComponent(filtering)}`
    + `&limit=500`
    + `&access_token=${token}`;

  const rows = await fetchAllPages(url);

  let spend = 0, leads = 0, mqls = 0, seguidores = 0;
  const campaigns = [];

  for (const row of rows) {
    const rowSpend = parseFloat(row.spend || 0);
    const rowLeads = sumActions(row.actions, 'lead');
    const rowMqls  = sumActions(row.actions,
      'offsite_conversion.custom.MQL',
      'MQL'
    );
    const rowSegs  = sumActions(row.actions,
      'onsite_conversion.follow',
      'page_fan_adds'
    );

    spend      += rowSpend;
    leads      += rowLeads;
    mqls       += rowMqls;
    seguidores += rowSegs;

    campaigns.push({
      id:      row.campaign_id,
      name:    row.campaign_name,
      spend:   Math.round(rowSpend * 100) / 100,
      leads:   rowLeads,
      mqls:    rowMqls,
      _actions: (row.actions || []).map(a => ({ type: a.action_type, value: a.value })),
    });
  }

  return {
    spend:      Math.round(spend * 100) / 100,
    leads,
    mqls,
    seguidores,
    campaigns,
  };
}

// ─── Handler principal ────────────────────────────────────────────────────────

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const token       = process.env.META_TOKEN;
  const rawId       = process.env.META_AD_ACCOUNT_ID;

  if (!token || !rawId) {
    return res.status(500).json({ error: 'META_TOKEN ou META_AD_ACCOUNT_ID não configurados' });
  }

  // Garante o prefixo act_ independente de como foi salvo no Vercel
  const adAccountId = rawId.startsWith('act_') ? rawId : `act_${rawId}`;

  const { since, until } = req.query;
  if (!since || !until) {
    return res.status(400).json({ error: 'Parâmetros since e until são obrigatórios (YYYY-MM-DD)' });
  }

  try {
    // 1. Busca todas as campanhas da conta (sem filtro de status — dados históricos precisam de pausadas/arquivadas)
    const campaignsUrl = `${BASE}/${adAccountId}/campaigns`
      + `?fields=id,name,effective_status`
      + `&limit=500`
      + `&access_token=${token}`;

    const allCampaigns = await fetchAllPages(campaignsUrl);

    // 2. Separa campanhas por funil com base no nome
    const funnelIds = { aplicacao: [], webinario: [], social_selling: [] };

    for (const c of allCampaigns) {
      if      (c.name.includes('Sessão'))   funnelIds.aplicacao.push(c.id);
      else if (c.name.includes('Web'))      funnelIds.webinario.push(c.id);
      else if (c.name.includes('Tráfego')) funnelIds.social_selling.push(c.id);
    }

    // 3. Busca insights de cada funil em paralelo
    const [aplData, webData, socData] = await Promise.all([
      getFunnelInsights(adAccountId, funnelIds.aplicacao,      since, until, token),
      getFunnelInsights(adAccountId, funnelIds.webinario,      since, until, token),
      getFunnelInsights(adAccountId, funnelIds.social_selling, since, until, token),
    ]);

    return res.status(200).json({
      source:  'meta_ads',
      period:  { since, until },
      aplicacao: {
        spend: aplData.spend,
        leads: aplData.leads,
        mqls:  aplData.mqls,
      },
      webinario: {
        spend: webData.spend,
        leads: webData.leads,
      },
      social_selling: {
        spend:      socData.spend,
        seguidores: socData.seguidores,
      },
      _debug: {
        totalCampaigns: allCampaigns.length,
        funnelCounts: {
          aplicacao:      funnelIds.aplicacao.length,
          webinario:      funnelIds.webinario.length,
          social_selling: funnelIds.social_selling.length,
        },
        allCampaigns: allCampaigns.map(c => ({ id: c.id, name: c.name, status: c.effective_status })),
        campaigns: {
          aplicacao:      aplData.campaigns,
          webinario:      webData.campaigns,
          social_selling: socData.campaigns,
        },
      },
    });

  } catch (err) {
    console.error('[meta]', err.message);
    return res.status(500).json({ error: err.message });
  }
}
