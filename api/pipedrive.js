// Vercel Serverless Function — Pipedrive API
// Chamada: GET /api/pipedrive?since=2026-01-01&until=2026-04-08

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

// ─── Busca IDs das etapas pelo nome ──────────────────────────────────────────

async function getStageIds(token, pipelineId) {
  const res  = await fetch(`${BASE}/stages?pipeline_id=${pipelineId}&api_token=${token}`);
  const json = await res.json();
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

// ─── Busca IDs dos labels (WEBINARIO e kommo) ────────────────────────────────
// No Pipedrive, o campo "Label" dos negócios guarda IDs numéricos, não texto

async function getLabelIds(token) {
  const res  = await fetch(`${BASE}/dealFields?api_token=${token}&limit=500`);
  const json = await res.json();

  // O campo de label nativo do Pipedrive tem key = "label"
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

  // label pode ser null, número, string ou array
  const dealLabels = raw == null
    ? []
    : (Array.isArray(raw) ? raw : String(raw).split(','))
        .map(l => l.trim())
        .filter(Boolean);

  if (labelIds.webinario && dealLabels.includes(String(labelIds.webinario))) return 'webinario';
  if (labelIds.kommo     && dealLabels.includes(String(labelIds.kommo)))     return 'social_selling';
  return 'aplicacao';
}

// ─── Calcula métricas ─────────────────────────────────────────────────────────

function calcMetrics(deals, stageIds, budgetKey, mqlIds) {
  const stageOrder = Object.fromEntries(stageIds.all.map(s => [s.id, s.order_nr]));
  const orderAgendado      = stageOrder[stageIds.agendado]      ?? 0;
  const orderCallRealizada = stageOrder[stageIds.callRealizada]  ?? 0;

  const leads  = deals.length;

  const mqls = deals.filter(d =>
    mqlIds.includes(String(d[budgetKey] ?? ''))
  ).length;

  const calls_agendadas = deals.filter(d =>
    d.status === 'won' || (stageOrder[d.stage_id] ?? -1) >= orderAgendado
  ).length;

  const calls_realizadas = deals.filter(d =>
    d.status === 'won' || (stageOrder[d.stage_id] ?? -1) >= orderCallRealizada
  ).length;

  const vendas  = deals.filter(d => d.status === 'won').length;
  const receita = deals
    .filter(d => d.status === 'won')
    .reduce((sum, d) => sum + (parseFloat(d.value) || 0), 0);

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

  try {
    const pipelineId = await getPipelineId(token);

    const [stageData, budgetField, labelIds, allDeals] = await Promise.all([
      getStageIds(token, pipelineId),
      getBudgetField(token),
      getLabelIds(token),
      // Busca todos os negócios do pipeline e filtra por add_time no código
      // (Pipedrive não aceita filtro por add_time via query params)
      fetchAll('/deals', token, {
        pipeline_id: pipelineId,
        status: 'all_not_deleted'
      })
    ]);

    // Filtra por add_time (data de entrada no CRM) dentro do período
    const sinceTs = new Date(since).getTime();
    const untilTs = new Date(until + 'T23:59:59').getTime();

    const deals = allDeals.filter(d => {
      const t = new Date(d.add_time).getTime();
      return t >= sinceTs && t <= untilTs;
    });

    // Separa por funil usando IDs reais dos labels
    const grupos = { aplicacao: [], webinario: [], social_selling: [] };
    for (const deal of deals) {
      grupos[getFunnel(deal, labelIds)].push(deal);
    }

    const calcArgs = [stageData, budgetField.key, budgetField.mqlIds];

    return res.status(200).json({
      source: 'pipedrive',
      period: { since, until },
      aplicacao:       calcMetrics(grupos.aplicacao,      ...calcArgs),
      webinario:       calcMetrics(grupos.webinario,       ...calcArgs),
      social_selling:  calcMetrics(grupos.social_selling,  ...calcArgs),
      total_leads_crm: deals.length,
      _debug: {
        stageIds: { agendado: stageData.agendado, callRealizada: stageData.callRealizada },
        budgetFieldKey: budgetField.key,
        mqlOptionIds: budgetField.mqlIds,
        labelIds,
        totalDealsNoPeriodo: deals.length,
        totalDealsNoPipeline: allDeals.length
      }
    });

  } catch (err) {
    console.error('[pipedrive]', err.message);
    return res.status(500).json({ error: err.message });
  }
}
