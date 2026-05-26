// Vercel Serverless Function — Pipedrive API
// Chamada: GET /api/pipedrive?since=2026-01-01&until=2026-04-30
//
// Cada métrica filtra pelo momento em que o evento ocorreu:
//   Leads  → add_time (quando entrou no CRM)
//   MQLs   → add_time (presença do campo Budget no momento de entrada)
//   Calls agendadas  → stage_change_time do negócio quando chegou à etapa "Agendado" ou além
//   Calls realizadas → stage_change_time quando chegou à etapa "Call Realizada" ou além
//   Vendas / Receita → won_time do negócio

const BASE = 'https://api.pipedrive.com/v1';

// ─── Autenticação ─────────────────────────────────────────────────────────────
// O Pipedrive descontinuou o api_token na query string. Agora o token vai no
// header x-api-token. Ref: https://pipedrive.readme.io/docs/core-api-concepts-authentication

function pdUrl(path, params = {}) {
  const qs = new URLSearchParams(params).toString();
  return `${BASE}${path}${qs ? `?${qs}` : ''}`;
}

async function pdGet(path, token, params = {}) {
  const res = await fetch(pdUrl(path, params), {
    headers: { 'x-api-token': token, Accept: 'application/json' }
  });
  return res.json();
}

// ─── Helper: busca todas as páginas de um endpoint ───────────────────────────

async function fetchAll(path, token, extraParams = {}) {
  let start = 0;
  const limit = 500;
  let all = [];

  while (true) {
    const json = await pdGet(path, token, { limit, start, ...extraParams });

    if (!json.success) throw new Error(`Pipedrive erro em ${path}: ${JSON.stringify(json.error)}`);

    all = all.concat(json.data || []);
    if (!json.additional_data?.pagination?.more_items_in_collection) break;
    start += limit;
  }

  return all;
}

// ─── Busca ID do pipeline "Comercial" ────────────────────────────────────────

async function getPipelineId(token) {
  const json = await pdGet('/pipelines', token);
  const pipelines = json.data || [];
  const p = pipelines.find(p => p.name?.trim().toLowerCase() === 'comercial');
  if (!p) {
    const found = pipelines.map(p => `"${p.name}"`).join(', ') || '(nenhum)';
    throw new Error(`Pipeline "Comercial" não encontrado. Pipelines visíveis para este token: ${found}`);
  }
  return p.id;
}

// ─── Busca IDs e ordem das etapas ────────────────────────────────────────────

async function getStageIds(token, pipelineId) {
  const json = await pdGet('/stages', token, { pipeline_id: pipelineId });
  const stages = json.data || [];
  const find = name => stages.find(s => s.name === name)?.id;
  return {
    agendado:      find('Agendado'),
    callRealizada: find('Call Realizada'),
    all: stages
  };
}

// ─── Busca campo Budget e IDs das opções MQL ─────────────────────────────────

async function getBudgetField(token) {
  const json = await pdGet('/dealFields', token, { limit: 500 });
  const field = json.data?.find(f => f.name === 'Budget');
  if (!field) throw new Error('Campo "Budget" não encontrado no Pipedrive');

  // MQL = faixas de alto valor. Casamos por ID das opções (estável), conforme
  // CLAUDE.md: 63 (R$10.001–15.000), 64 (R$15.001–50.000),
  // 65 (R$50.001–100.000), 66 (Mais de R$100.000).
  const MQL_OPTION_IDS = ['63', '64', '65', '66'];

  const optionIds = new Set((field.options || []).map(o => String(o.id)));
  const mqlIds = MQL_OPTION_IDS.filter(id => optionIds.has(id));

  return { key: field.key, mqlIds };
}

// ─── Busca IDs dos labels (WEBNARIO e LEAD KOMMO) ────────────────────────────
// IDs conhecidos como fallback (CLAUDE.md): WEBNARIO=121, LEAD KOMMO=21

async function getLabelIds(token) {
  const json = await pdGet('/dealFields', token, { limit: 500 });

  const labelField = json.data?.find(f => f.key === 'label');

  let webinarioId = null;
  let kommoId     = null;
  let allLabels   = [];

  if (labelField?.options) {
    allLabels = labelField.options.map(o => ({ id: o.id, label: o.label }));
    const find = name => labelField.options
      .find(o => o.label.toLowerCase() === name.toLowerCase())?.id;
    webinarioId = find('WEBNARIO');
    kommoId     = find('LEAD KOMMO');
  }

  // Fallback para IDs conhecidos caso a busca dinâmica falhe
  if (webinarioId == null) webinarioId = 121;
  if (kommoId     == null) kommoId     = 21;

  return {
    webinario:  String(webinarioId),
    kommo:      String(kommoId),
    _allLabels: allLabels
  };
}

// ─── Identifica funil pelo label do negócio ───────────────────────────────────

function getFunnel(deal, labelIds) {
  const raw = deal.label;

  const dealLabels = raw == null
    ? []
    : (Array.isArray(raw) ? raw : String(raw).split(','))
        .map(l => l.trim())
        .filter(Boolean);

  if (labelIds.webinario && dealLabels.includes(String(labelIds.webinario))) return 'webinario';
  if (labelIds.kommo     && dealLabels.includes(String(labelIds.kommo)))     return 'social_selling';
  return 'aplicacao';
}

// ─── Calcula métricas por funil ───────────────────────────────────────────────
//
// Leads / MQLs  → negócios criados (add_time) no período
// Calls         → entre os leads criados no período, quantos já alcançaram essa etapa
//                 (etapa atual >= threshold = o negócio passou por lá em algum momento)
//                 Ganhos também contam pois passaram por todas as etapas
// Vendas/Receita → todos os negócios ganhos (won_time) no período,
//                  independente de quando foram criados

function calcFunnelMetrics(allDeals, funnelDealIds, stageIds, budgetKey, mqlIds, sinceTs, untilTs) {
  const stageOrder    = Object.fromEntries(stageIds.all.map(s => [s.id, s.order_nr]));
  const orderAgendado = stageOrder[stageIds.agendado]     ?? 0;
  const orderCallReal = stageOrder[stageIds.callRealizada] ?? 0;

  const funnelDeals = allDeals.filter(d => funnelDealIds.has(d.id));

  // ── Leads e MQLs: filtrados por add_time ──
  const leadsInPeriod = funnelDeals.filter(d => {
    const t = new Date(d.add_time).getTime();
    return t >= sinceTs && t <= untilTs;
  });
  const leads = leadsInPeriod.length;
  const mqls  = leadsInPeriod.filter(d =>
    mqlIds.includes(String(d[budgetKey] ?? ''))
  ).length;

  // ── Calls agendadas: leads criados no período que chegaram a "Agendado" ou além ──
  // Se etapa atual >= Agendado (ou ganho), o negócio passou pela etapa de agendamento
  const calls_agendadas = leadsInPeriod.filter(d => {
    if (d.status === 'won') return true;
    const order = stageOrder[d.stage_id] ?? -1;
    return order >= orderAgendado;
  }).length;

  // ── Calls realizadas: leads criados no período que chegaram a "Call Realizada" ou além ──
  const calls_realizadas = leadsInPeriod.filter(d => {
    if (d.status === 'won') return true;
    const order = stageOrder[d.stage_id] ?? -1;
    return order >= orderCallReal;
  }).length;

  // ── Vendas e Receita: negócios ganhos com won_time no período (qualquer add_time) ──
  const wonDeals = funnelDeals.filter(d => {
    if (d.status !== 'won' || !d.won_time) return false;
    const t = new Date(d.won_time).getTime();
    return t >= sinceTs && t <= untilTs;
  });
  const vendas  = wonDeals.length;
  const receita = wonDeals.reduce((sum, d) => sum + (parseFloat(d.value) || 0), 0);
  const wonList = wonDeals.map(d => ({ id: d.id, title: d.title, value: parseFloat(d.value) || 0, won_time: d.won_time }));

  // ── Leads/MQLs agrupados por dia (add_time) para o gráfico de linha ──
  const dailyMap = {};
  for (const d of leadsInPeriod) {
    const dateStr = d.add_time.substring(0, 10);
    if (!dailyMap[dateStr]) dailyMap[dateStr] = { leads: 0, mqls: 0 };
    dailyMap[dateStr].leads++;
    if (mqlIds.includes(String(d[budgetKey] ?? ''))) dailyMap[dateStr].mqls++;
  }
  const daily = Object.entries(dailyMap)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, v]) => ({ date, leads: v.leads, mqls: v.mqls }));

  return { leads, mqls, calls_agendadas, calls_realizadas, vendas, receita, wonList, daily };
}

// ─── Handler principal ────────────────────────────────────────────────────────

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const token = process.env.PIPEDRIVE_TOKEN;
  if (!token) return res.status(500).json({ error: 'PIPEDRIVE_TOKEN não configurado' });

  const { since, until } = req.query;
  if (!since || !until) {
    return res.status(400).json({ error: 'Parâmetros since e until são obrigatórios (YYYY-MM-DD)' });
  }

  // Pipedrive armazena datetimes em UTC. O usuário está em Brasília (UTC-3).
  // "31/03 às 23:09 BRT" = "01/04 às 02:09 UTC" no banco do Pipedrive.
  // Usando offset -03:00 no since/until, garantimos que o "início de abril" seja
  // 01/04T00:00-03:00 = 01/04T03:00Z, que é posterior ao won_time de 01/04T02:09Z.
  const sinceTs = new Date(since + 'T00:00:00-03:00').getTime();
  const untilTs = new Date(until + 'T23:59:59-03:00').getTime();

  try {
    const pipelineId = await getPipelineId(token);

    const [stageData, budgetField, labelIds, allDeals] = await Promise.all([
      getStageIds(token, pipelineId),
      getBudgetField(token),
      getLabelIds(token),
      fetchAll('/deals', token, {
        pipeline_id: pipelineId,
        status: 'all_not_deleted'
      })
    ]);

    // Separa IDs dos negócios por funil (considera todos, não só do período)
    const funnelIds = {
      aplicacao:      new Set(),
      webinario:      new Set(),
      social_selling: new Set()
    };
    for (const deal of allDeals) {
      funnelIds[getFunnel(deal, labelIds)].add(deal.id);
    }

    const aplicacao      = calcFunnelMetrics(allDeals, funnelIds.aplicacao,      stageData, budgetField.key, budgetField.mqlIds, sinceTs, untilTs);
    const webinario      = calcFunnelMetrics(allDeals, funnelIds.webinario,      stageData, budgetField.key, budgetField.mqlIds, sinceTs, untilTs);
    const social_selling = calcFunnelMetrics(allDeals, funnelIds.social_selling, stageData, budgetField.key, budgetField.mqlIds, sinceTs, untilTs);

    // Total de leads no período (add_time)
    const total_leads_crm = allDeals.filter(d => {
      const t = new Date(d.add_time).getTime();
      return t >= sinceTs && t <= untilTs;
    }).length;

    return res.status(200).json({
      source: 'pipedrive',
      period: { since, until },
      aplicacao,
      webinario,
      social_selling,
      total_leads_crm,
      _debug: {
        stageIds:            { agendado: stageData.agendado, callRealizada: stageData.callRealizada },
        budgetFieldKey:      budgetField.key,
        mqlOptionIds:        budgetField.mqlIds,
        labelIds,
        totalDealsNoPipeline: allDeals.length
      }
    });

  } catch (err) {
    console.error('[pipedrive]', err.message);
    return res.status(500).json({ error: err.message });
  }
}
