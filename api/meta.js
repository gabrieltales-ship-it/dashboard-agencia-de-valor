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

// ─── Busca spend diário (time_increment=1) para uma lista de campaign IDs ────

async function getDailySpend(adAccountId, campaignIds, since, until, token) {
  if (campaignIds.length === 0) return [];

  const timeRange = JSON.stringify({ since, until });
  const filtering = JSON.stringify([
    { field: 'campaign.id', operator: 'IN', value: campaignIds }
  ]);

  const url = `${BASE}/${adAccountId}/insights`
    + `?level=campaign`
    + `&fields=spend,date_start`
    + `&time_range=${encodeURIComponent(timeRange)}`
    + `&time_increment=1`
    + `&filtering=${encodeURIComponent(filtering)}`
    + `&limit=500`
    + `&access_token=${token}`;

  const rows = await fetchAllPages(url);

  const byDate = {};
  for (const row of rows) {
    const date = row.date_start;
    byDate[date] = (byDate[date] || 0) + parseFloat(row.spend || 0);
  }

  return Object.entries(byDate)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, spend]) => ({ date, spend: Math.round(spend * 100) / 100 }));
}

// ─── Busca breakdown por dimensão (age ou gender) ────────────────────────────

async function getBreakdown(adAccountId, campaignIds, breakdown, since, until, token, mqlActionType) {
  if (campaignIds.length === 0) return [];

  const timeRange = JSON.stringify({ since, until });
  const filtering = JSON.stringify([
    { field: 'campaign.id', operator: 'IN', value: campaignIds }
  ]);

  const url = `${BASE}/${adAccountId}/insights`
    + `?level=campaign`
    + `&fields=spend,actions,${breakdown}`
    + `&breakdowns=${breakdown}`
    + `&time_range=${encodeURIComponent(timeRange)}`
    + `&filtering=${encodeURIComponent(filtering)}`
    + `&limit=500`
    + `&access_token=${token}`;

  const rows = await fetchAllPages(url);

  const byDim = {};
  for (const row of rows) {
    const dim = row[breakdown] || 'unknown';
    if (!byDim[dim]) byDim[dim] = { spend: 0, leads: 0 };
    byDim[dim].spend += parseFloat(row.spend || 0);
    byDim[dim].leads += sumActions(row.actions, 'lead');
  }

  return Object.entries(byDim).map(([dim, v]) => ({
    [breakdown]: dim,
    spend: Math.round(v.spend * 100) / 100,
    leads: v.leads,
    cpl:   v.leads > 0 ? Math.round(v.spend / v.leads * 100) / 100 : 0,
  }));
}

// ─── Busca todos os dados de UMA conta de anúncios ────────────────────────────

async function getAccountData(adAccountId, since, until, token) {
  // 1. Campanhas da conta (inclui daily_budget)
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

  // 3. action_type do MQL (custom conversion específica desta conta)
  const mqlActionType = await getMqlActionType(adAccountId, token);

  // 4. Insights de campanha, adset e ad — todos em paralelo
  const [
    aplData, webData, socData,
    aplAdsets, webAdsets, socAdsets,
    aplAds, webAds, socAds,
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
  ]);

  // 5. Dados de gráfico (diário + breakdowns) — allSettled para não quebrar a resposta
  const [dailyRes, ageRes, genderRes] = await Promise.allSettled([
    getDailySpend(adAccountId, funnelIds.aplicacao, since, until, token),
    getBreakdown(adAccountId, funnelIds.aplicacao, 'age',    since, until, token, mqlActionType),
    getBreakdown(adAccountId, funnelIds.aplicacao, 'gender', since, until, token, mqlActionType),
  ]);

  return {
    aplicacao: {
      spend:            aplData.spend,
      leads:            aplData.leads,
      mqls:             aplData.mqls,
      campaigns:        aplData.campaigns,
      adsets:           aplAdsets,
      ads:              aplAds,
      daily:            dailyRes.status  === 'fulfilled' ? dailyRes.value  : [],
      age_breakdown:    ageRes.status    === 'fulfilled' ? ageRes.value    : [],
      gender_breakdown: genderRes.status === 'fulfilled' ? genderRes.value : [],
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
    _meta: {
      adAccountId,
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
  };
}

// ─── Merge de múltiplas contas ────────────────────────────────────────────────

const round2 = n => Math.round(n * 100) / 100;

// Série diária: combina por data somando todos os campos numéricos (ex: spend)
function mergeDaily(lists) {
  const byDate = {};
  for (const list of lists) {
    for (const r of list) {
      if (!byDate[r.date]) byDate[r.date] = { date: r.date, spend: 0 };
      byDate[r.date].spend += r.spend || 0;
    }
  }
  return Object.values(byDate)
    .sort((a, b) => a.date.localeCompare(b.date))
    .map(d => ({ date: d.date, spend: round2(d.spend) }));
}

// Breakdown (age/gender): combina por dimensão somando spend+leads e recalcula CPL
function mergeBreakdown(lists, dimKey) {
  const byDim = {};
  for (const list of lists) {
    for (const r of list) {
      const dim = r[dimKey];
      if (!byDim[dim]) byDim[dim] = { spend: 0, leads: 0 };
      byDim[dim].spend += r.spend || 0;
      byDim[dim].leads += r.leads || 0;
    }
  }
  return Object.entries(byDim).map(([dim, v]) => ({
    [dimKey]: dim,
    spend: round2(v.spend),
    leads: v.leads,
    cpl:   v.leads > 0 ? round2(v.spend / v.leads) : 0,
  }));
}

// Funde os resultados de N contas num único objeto com a mesma forma de saída
function mergeAccounts(accounts) {
  const sum = key => round2(accounts.reduce((s, a) => s + (a.aplicacao[key] || 0), 0));
  const sumF = (funnel, key) => round2(accounts.reduce((s, a) => s + (a[funnel][key] || 0), 0));
  const concat = (funnel, key) => accounts.flatMap(a => a[funnel][key] || []);

  return {
    aplicacao: {
      spend:            sumF('aplicacao', 'spend'),
      leads:            accounts.reduce((s, a) => s + a.aplicacao.leads, 0),
      mqls:             accounts.reduce((s, a) => s + a.aplicacao.mqls, 0),
      campaigns:        concat('aplicacao', 'campaigns'),
      adsets:           concat('aplicacao', 'adsets'),
      ads:              concat('aplicacao', 'ads'),
      daily:            mergeDaily(accounts.map(a => a.aplicacao.daily)),
      age_breakdown:    mergeBreakdown(accounts.map(a => a.aplicacao.age_breakdown), 'age'),
      gender_breakdown: mergeBreakdown(accounts.map(a => a.aplicacao.gender_breakdown), 'gender'),
    },
    webinario: {
      spend:     sumF('webinario', 'spend'),
      leads:     accounts.reduce((s, a) => s + a.webinario.leads, 0),
      campaigns: concat('webinario', 'campaigns'),
      adsets:    concat('webinario', 'adsets'),
      ads:       concat('webinario', 'ads'),
    },
    social_selling: {
      spend:      sumF('social_selling', 'spend'),
      seguidores: accounts.reduce((s, a) => s + a.social_selling.seguidores, 0),
      campaigns:  concat('social_selling', 'campaigns'),
      adsets:     concat('social_selling', 'adsets'),
      ads:        concat('social_selling', 'ads'),
    },
  };
}

// ─── Experts (cada expert = uma conta de anúncios) ────────────────────────────
// O ID vem das env vars já existentes (com fallback para os IDs conhecidos).
//   Robson → conta principal (META_AD_ACCOUNT_ID)
//   João   → segunda conta   (META_AD_ACCOUNT_ID_2)

const EXPERTS = [
  { slug: 'robson', name: 'Robson', rawId: process.env.META_AD_ACCOUNT_ID   || '1075157712573443' },
  { slug: 'joao',   name: 'João',   rawId: process.env.META_AD_ACCOUNT_ID_2 || '24634931902871157' },
];

// Normaliza: remove espaços e qualquer prefixo act_/act= colado por engano.
function normalizeAccountId(raw) {
  const clean = String(raw).trim().replace(/^act[_=\s]*/i, '');
  return `act_${clean}`;
}

// ─── Handler principal ────────────────────────────────────────────────────────

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const token = process.env.META_TOKEN;
  if (!token) {
    return res.status(500).json({ error: 'META_TOKEN não configurado' });
  }

  const { since, until } = req.query;
  if (!since || !until) {
    return res.status(400).json({ error: 'Parâmetros since e until são obrigatórios (YYYY-MM-DD)' });
  }

  try {
    // Busca a conta de cada expert em paralelo. allSettled garante que uma conta
    // com problema (ID errado, sem permissão) não derrube o painel inteiro.
    const settled = await Promise.allSettled(
      EXPERTS.map(e => getAccountData(normalizeAccountId(e.rawId), since, until, token))
    );

    const accounts = [];   // todas as contas lidas → usadas para o Geral
    const experts  = {};   // dados por expert (Aplicação + Social Selling)
    const failures = [];

    settled.forEach((s, i) => {
      const e = EXPERTS[i];
      if (s.status === 'fulfilled') {
        accounts.push(s.value);
        experts[e.slug] = {
          name:           e.name,
          aplicacao:      s.value.aplicacao,
          social_selling: s.value.social_selling,
        };
      } else {
        failures.push({ expert: e.slug, accountId: normalizeAccountId(e.rawId), error: s.reason?.message });
      }
    });

    if (accounts.length === 0) {
      throw new Error(`Nenhuma conta Meta pôde ser lida. Falhas: ${JSON.stringify(failures)}`);
    }

    // Geral = soma de todas as contas (inclui Webinário compartilhado)
    const merged = mergeAccounts(accounts);

    return res.status(200).json({
      source: 'meta_ads',
      period: { since, until },
      ...merged,     // geral no topo (compatível com o frontend atual)
      experts,       // { robson: {...}, joao: {...} }
      _debug: {
        accounts: accounts.map(a => a._meta),
        failures,
        expertMap: EXPERTS.map(e => ({ slug: e.slug, name: e.name, accountId: normalizeAccountId(e.rawId) })),
      },
    });

  } catch (err) {
    console.error('[meta]', err.message);
    return res.status(500).json({ error: err.message });
  }
}
