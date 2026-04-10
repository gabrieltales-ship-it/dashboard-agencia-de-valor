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
//   Seguidores → action_type: "onsite_conversion.follow"

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

// ─── Busca o action_type da Custom Conversion "MQL" ─────────────────────────

async function getMqlActionType(adAccountId, token) {
  const url = `${BASE}/${adAccountId}/customconversions?fields=id,name&limit=100&access_token=${token}`;
  const res  = await fetch(url);
  const json = await res.json();
  if (json.error || !json.data) return null;
  const mql = json.data.find(c => c.name.trim().toUpperCase() === 'MQL');
  if (!mql) return null;
  return `offsite_conversion.custom.${mql.id}`;
}

// ─── Busca insights agregados para uma lista de campaign IDs ─────────────────

async function getFunnelInsights(adAccountId, campaignIds, since, until, token, mqlActionType, budgetMap) {
  if (campaignIds.length === 0) {
    return { spend: 0, leads: 0, mqls: 0, seguidores: 0, campaigns: [] };
  }

  const timeRange = JSON.stringify({ since, until });
  const filtering = JSON.stringify([
    { field: 'campaign.id', operator: 'IN', value: campaignIds }
  ]);
  const fields = 'campaign_id,campaign_name,spend,actions,impressions,reach,clicks,ctr';

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
    const mqlTypes = ['offsite_conversion.custom.MQL', 'MQL'];
    if (mqlActionType) mqlTypes.unshift(mqlActionType);
    const rowMqls  = sumActions(row.actions, ...mqlTypes);
    const rowSegs  = sumActions(row.actions, 'onsite_conversion.follow', 'follow');

    spend      += rowSpend;
    leads      += rowLeads;
    mqls       += rowMqls;
    seguidores += rowSegs;

    campaigns.push({
      id:           row.campaign_id,
      name:         row.campaign_name,
      daily_budget: (budgetMap || {})[row.campaign_id] || 0,
      spend:        Math.round(rowSpend * 100) / 100,
      leads:        rowLeads,
      mqls:         rowMqls,
      seguidores:   rowSegs,
      impressions:  parseInt(row.impressions || 0),
      reach:        parseInt(row.reach || 0),
      clicks:       parseInt(row.clicks || 0),
      ctr:          parseFloat(row.ctr || 0),
      _actions:     (row.actions || []).map(a => ({ type: a.action_type, value: a.value })),
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

// ─── Busca insights por nível adset ou ad ────────────────────────────────────

async function getInsightsByLevel(adAccountId, campaignIds, level, since, until, token, mqlActionType) {
  if (campaignIds.length === 0) return [];

  const isAd      = level === 'ad';
  const nameField = isAd ? 'ad_id,ad_name' : 'adset_id,adset_name';
  const fields    = `campaign_id,${nameField},spend,actions,impressions,reach,clicks,ctr`;
  const timeRange = JSON.stringify({ since, until });
  const filtering = JSON.stringify([
    { field: 'campaign.id', operator: 'IN', value: campaignIds }
  ]);

  const url = `${BASE}/${adAccountId}/insights`
    + `?level=${level}`
    + `&fields=${encodeURIComponent(fields)}`
    + `&time_range=${encodeURIComponent(timeRange)}`
    + `&filtering=${encodeURIComponent(filtering)}`
    + `&limit=500`
    + `&access_token=${token}`;

  const rows = await fetchAllPages(url);

  const mqlTypes = ['offsite_conversion.custom.MQL', 'MQL'];
  if (mqlActionType) mqlTypes.unshift(mqlActionType);

  return rows.map(row => {
    const rowSpend = parseFloat(row.spend || 0);
    return {
      id:          isAd ? row.ad_id : row.adset_id,
      name:        isAd ? row.ad_name : row.adset_name,
      campaign_id: row.campaign_id,
      spend:       Math.round(rowSpend * 100) / 100,
      leads:       sumActions(row.actions, 'lead'),
      mqls:        sumActions(row.actions, ...mqlTypes),
      seguidores:  sumActions(row.actions, 'onsite_conversion.follow', 'follow'),
      impressions: parseInt(row.impressions || 0),
      reach:       parseInt(row.reach || 0),
      clicks:      parseInt(row.clicks || 0),
      ctr:         parseFloat(row.ctr || 0),
    };
  });
}

// ─── Busca spend diário para uma lista de campaign IDs ───────────────────────

async function getDailySpend(adAccountId, campaignIds, since, until, token) {
  if (campaignIds.length === 0) return [];

  const timeRange = JSON.stringify({ since, until });
  const filtering = JSON.stringify([
    { field: 'campaign.id', operator: 'IN', value: campaignIds }
  ]);

  const url = `${BASE}/${adAccountId}/insights`
    + `?level=campaign`
    + `&fields=spend`
    + `&time_range=${encodeURIComponent(timeRange)}`
    + `&time_increment=1`
    + `&filtering=${encodeURIComponent(filtering)}`
    + `&limit=500`
    + `&access_token=${token}`;

  const rows = await fetchAllPages(url);

  // Agrupa por data (pode haver múltiplas campanhas por dia)
  const byDate = {};
  for (const row of rows) {
    const date = row.date_start;
    byDate[date] = (byDate[date] || 0) + parseFloat(row.spend || 0);
  }

  return Object.entries(byDate)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, spend]) => ({ date, spend: Math.round(spend * 100) / 100 }));
}

// ─── Handler principal ────────────────────────────────────────────────────────

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const token  = process.env.META_TOKEN;
  const rawId  = process.env.META_AD_ACCOUNT_ID;

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
    // 1. Busca todas as campanhas da conta (inclui daily_budget)
    const campaignsUrl = `${BASE}/${adAccountId}/campaigns`
      + `?fields=id,name,effective_status,daily_budget`
      + `&limit=500`
      + `&access_token=${token}`;

    const allCampaigns = await fetchAllPages(campaignsUrl);

    // Mapa campaignId → daily_budget em BRL (Meta retorna em centavos)
    const budgetMap = Object.fromEntries(
      allCampaigns.map(c => [c.id, parseInt(c.daily_budget || 0) / 100])
    );

    // 2. Separa campanhas por funil com base no nome
    const funnelIds = { aplicacao: [], webinario: [], social_selling: [] };

    for (const c of allCampaigns) {
      if      (c.name.includes('Sessão'))   funnelIds.aplicacao.push(c.id);
      else if (c.name.includes('Web'))      funnelIds.webinario.push(c.id);
      else if (c.name.includes('Tráfego')) funnelIds.social_selling.push(c.id);
    }

    // 3. Busca o action_type do MQL
    const mqlActionType = await getMqlActionType(adAccountId, token);

    // 4. Insights de campanha, adset, ad e breakdown diário — todos em paralelo
    const [
      aplData, webData, socData,
      aplAdsets, webAdsets, socAdsets,
      aplAds, webAds, socAds,
      aplDaily,
    ] = await Promise.all([
      getFunnelInsights(adAccountId, funnelIds.aplicacao,      since, until, token, mqlActionType, budgetMap),
      getFunnelInsights(adAccountId, funnelIds.webinario,      since, until, token, mqlActionType, budgetMap),
      getFunnelInsights(adAccountId, funnelIds.social_selling, since, until, token, mqlActionType, budgetMap),
      getInsightsByLevel(adAccountId, funnelIds.aplicacao,      'adset', since, until, token, mqlActionType),
      getInsightsByLevel(adAccountId, funnelIds.webinario,      'adset', since, until, token, mqlActionType),
      getInsightsByLevel(adAccountId, funnelIds.social_selling, 'adset', since, until, token, mqlActionType),
      getInsightsByLevel(adAccountId, funnelIds.aplicacao,      'ad',    since, until, token, mqlActionType),
      getInsightsByLevel(adAccountId, funnelIds.webinario,      'ad',    since, until, token, mqlActionType),
      getInsightsByLevel(adAccountId, funnelIds.social_selling, 'ad',    since, until, token, mqlActionType),
      getDailySpend(adAccountId, funnelIds.aplicacao, since, until, token),
    ]);

    return res.status(200).json({
      source: 'meta_ads',
      period: { since, until },
      aplicacao: {
        spend:     aplData.spend,
        leads:     aplData.leads,
        mqls:      aplData.mqls,
        campaigns: aplData.campaigns,
        adsets:    aplAdsets,
        ads:       aplAds,
        daily:     aplDaily,
      },
      webinario: {
        spend:     webData.spend,
        leads:     webData.leads,
        campaigns: webData.campaigns,
        adsets:    webAdsets,
        ads:       webAds,
      },
      social_selling: {
        spend:      socData.spend,
        seguidores: socData.seguidores,
        campaigns:  socData.campaigns,
        adsets:     socAdsets,
        ads:        socAds,
      },
      _debug: {
        mqlActionType,
        totalCampaigns: allCampaigns.length,
        funnelCounts: {
          aplicacao:      funnelIds.aplicacao.length,
          webinario:      funnelIds.webinario.length,
          social_selling: funnelIds.social_selling.length,
        },
        allCampaigns: allCampaigns.map(c => ({
          id:           c.id,
          name:         c.name,
          status:       c.effective_status,
          daily_budget: parseInt(c.daily_budget || 0) / 100,
        })),
      },
    });

  } catch (err) {
    console.error('[meta]', err.message);
    return res.status(500).json({ error: err.message });
  }
}
