// Vercel Serverless Function — Pipedrive API
// Chamada: GET /api/pipedrive?since=2026-01-01&until=2026-04-30
//
// Cada métrica filtra pelo momento em que o evento ocorreu:
//   Leads  → add_time (quando entrou no CRM)
//   MQLs   → add_time (presença do campo Budget no momento de entrada)
//   Calls agendadas  → due_date da atividade de call no período
//   Calls realizadas → due_date da atividade de call + done=true no período
//   Vendas / Receita → won_time do negócio no período

const BASE = 'https://api.pipedrive.com/v1';

// ─── Helper: busca todas as páginas de um endpoint ───────────────────────────

async function fetchAll(path, token, extraParams = {}) {
  let start = 0;
  const limit = 500;
  let all = [];

  while (true) {
    const params = new URLSearchParams({ api_token: token, limit, start, ...extraParams });
    const res  = await fetch(`${BASE}${path}?${params}`);
    const json = await res.json();

    if (!json.success) throw new Error(`Pipedrive erro em ${path}: ${JSON.stringify(json.error)}`);

    all = all.concat(json.data || []);
    if (!json.additional_data?.pagination?.more_items_in_collection) break;
    start += limit;
  }

  return all;
}

// ─── Busca ID do pipeline "Comercial" ────────────────────────────────────────

async function getPipelineId(token) {
  const res  = await fetch(`${BASE}/pipelines?api_token=${token}`);
  const json = await res.json();
  const p = json.data?.find(p => p.name === 'Comercial');
  if (!p) throw new Error('Pipeline "Comercial" não encontrado');
  return p.id;
}

// ─── Busca campo Budget e IDs das opções MQL ─────────────────────────────────

async function getBudgetField(token) {
  const res  = await fetch(`${BASE}/dealFields?api_token=${token}&limit=500`);
  const json = await res.json();
  const field = json.data?.find(f => f.name === 'Budget');
  if (!field) throw new Error('Campo "Budget" não encontrado no Pipedrive');

  const mqlLabels = [
    'De R$ 10.001 a R$15.000 por mês',
    'De R$ 15.001 a R$50.000 por mês',
    'De R$ 50.001 a R$100.000 por mês',
    'Mais de R$1000.000 por mês'
  ];

  const mqlIds = field.options
    ?.filter(o => mqlLabels.some(l => o.label.trim() === l.trim()))
    .map(o => String(o.id)) || [];

  return { key: field.key, mqlIds };
}

// ─── Busca IDs dos labels (WEBNARIO e LEAD KOMMO) ────────────────────────────

async function getLabelIds(token) {
  const res  = await fetch(`${BASE}/dealFields?api_token=${token}&limit=500`);
  const json = await res.json();

  const labelField = json.data?.find(f => f.key === 'label');
  if (!labelField?.options) return { webinario: null, kommo: null };

  const find = name => labelField.options
    .find(o => o.label.toLowerCase() === name.toLowerCase())?.id;

  const webinarioId = find('WEBNARIO');
  const kommoId     = find('LEAD KOMMO');

  return {
    webinario: webinarioId != null ? String(webinarioId) : null,
    kommo:     kommoId     != null ? String(kommoId)     : null,
    _allLabels: labelField.options.map(o => ({ id: o.id, label: o.label }))
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
// Cada métrica usa a data do evento, não a data de entrada do lead.

function calcFunnelMetrics(allDeals, activities, funnelDealIds, budgetKey, mqlIds, sinceTs, untilTs) {

  // Leads = negócios deste funil com add_time no período
  const leadsInPeriod = allDeals.filter(d => {
    if (!funnelDealIds.has(d.id)) return false;
    const t = new Date(d.add_time).getTime();
    return t >= sinceTs && t <= untilTs;
  });

  const leads = leadsInPeriod.length;
  const mqls  = leadsInPeriod.filter(d =>
    mqlIds.includes(String(d[budgetKey] ?? ''))
  ).length;

  // Calls = atividades de call deste funil com due_date no período (já pré-filtradas)
  const funnelActivities = activities.filter(a => funnelDealIds.has(a.deal_id));
  const calls_agendadas  = funnelActivities.length;
  const calls_realizadas = funnelActivities.filter(a => a.done === true || a.done === 1).length;

  // Vendas/Receita = negócios ganhos com won_time no período
  const wonDeals = allDeals.filter(d => {
    if (!funnelDealIds.has(d.id)) return false;
    if (d.status !== 'won' || !d.won_time) return false;
    const t = new Date(d.won_time).getTime();
    return t >= sinceTs && t <= untilTs;
  });

  const vendas  = wonDeals.length;
  const receita = wonDeals.reduce((sum, d) => sum + (parseFloat(d.value) || 0), 0);

  return { leads, mqls, calls_agendadas, calls_realizadas, vendas, receita };
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

  const sinceTs = new Date(since).getTime();
  const untilTs = new Date(until + 'T23:59:59').getTime();

  try {
    const pipelineId = await getPipelineId(token);

    // Busca em paralelo: negócios, campos, labels e atividades de call no período
    const [budgetField, labelIds, allDeals, allActivities] = await Promise.all([
      getBudgetField(token),
      getLabelIds(token),
      fetchAll('/deals', token, {
        pipeline_id: pipelineId,
        status: 'all_not_deleted'
      }),
      fetchAll('/activities', token, {
        type:       'call',
        start_date: since,
        end_date:   until
      })
    ]);

    // Mapa id→deal para cruzar atividades com o pipeline correto
    const dealMap = new Map(allDeals.map(d => [d.id, d]));

    // Atividades de call cujo negócio está no pipeline "Comercial"
    const pipelineActivities = allActivities.filter(
      a => a.deal_id && dealMap.has(a.deal_id)
    );

    // Separa IDs dos negócios por funil (usando todos os negócios, não só do período)
    const funnelIds = { aplicacao: new Set(), webinario: new Set(), social_selling: new Set() };
    for (const deal of allDeals) {
      funnelIds[getFunnel(deal, labelIds)].add(deal.id);
    }

    const calcArgs = [allDeals, pipelineActivities, null, budgetField.key, budgetField.mqlIds, sinceTs, untilTs];

    const aplicacao      = calcFunnelMetrics(allDeals, pipelineActivities, funnelIds.aplicacao,      budgetField.key, budgetField.mqlIds, sinceTs, untilTs);
    const webinario      = calcFunnelMetrics(allDeals, pipelineActivities, funnelIds.webinario,      budgetField.key, budgetField.mqlIds, sinceTs, untilTs);
    const social_selling = calcFunnelMetrics(allDeals, pipelineActivities, funnelIds.social_selling, budgetField.key, budgetField.mqlIds, sinceTs, untilTs);

    // Total de leads no período (soma dos 3 funis por add_time)
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
        budgetFieldKey:      budgetField.key,
        mqlOptionIds:        budgetField.mqlIds,
        labelIds,
        totalDealsNoPipeline: allDeals.length,
        totalActivitiesNoPeriodo: pipelineActivities.length
      }
    });

  } catch (err) {
    console.error('[pipedrive]', err.message);
    return res.status(500).json({ error: err.message });
  }
}
