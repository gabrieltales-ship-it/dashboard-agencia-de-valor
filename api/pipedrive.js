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

// ─── Busca IDs e ordem das etapas ────────────────────────────────────────────

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
//
// Calls: usa stage_change_time (quando o negócio mudou para a etapa atual).
//   - Negócio atualmente em "Agendado" com stage_change_time no período → agendada no período ✓
//   - Negócio atualmente em "Call Realizada" com stage_change_time no período → realizada no período ✓
//   - Negócio ganho (won) com won_time no período → conta como agendada E realizada ✓
//   - Negócio em etapas posteriores (além de Call Realizada) com stage_change_time no período →
//     conta para realizadas mas NÃO para agendadas (a call foi agendada em período anterior)
//
// Limitação conhecida: um negócio que passou por "Agendado" em período anterior e foi para
// "Call Realizada" no período atual conta apenas como realizada, não como agendada.
// Isso é correto — a agendada foi em outro período.

function calcFunnelMetrics(allDeals, funnelDealIds, stageIds, budgetKey, mqlIds, sinceTs, untilTs) {
  const stageOrder       = Object.fromEntries(stageIds.all.map(s => [s.id, s.order_nr]));
  const orderAgendado    = stageOrder[stageIds.agendado]      ?? 0;
  const orderCallReal    = stageOrder[stageIds.callRealizada]  ?? 0;

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

  // ── Calls agendadas: negócios que chegaram à etapa "Agendado" no período ──
  // Cobre: atualmente em Agendado (stage_change_time no período)
  //        + ganhos no período (won_time no período — passaram por Agendado)
  const calls_agendadas = funnelDeals.filter(d => {
    // Negócio ganho no período
    if (d.status === 'won' && d.won_time) {
      const t = new Date(d.won_time).getTime();
      return t >= sinceTs && t <= untilTs;
    }
    // Negócio ativo/perdido: verificar stage_change_time e etapa atual
    if (!d.stage_change_time) return false;
    const t     = new Date(d.stage_change_time).getTime();
    const order = stageOrder[d.stage_id] ?? -1;
    // Conta apenas se a etapa atual for exatamente "Agendado"
    // (etapas além de Agendado têm stage_change_time mais recente que o de Agendado)
    return t >= sinceTs && t <= untilTs && order === orderAgendado;
  }).length;

  // ── Calls realizadas: negócios que chegaram à etapa "Call Realizada" ou além no período ──
  const calls_realizadas = funnelDeals.filter(d => {
    // Negócio ganho no período
    if (d.status === 'won' && d.won_time) {
      const t = new Date(d.won_time).getTime();
      return t >= sinceTs && t <= untilTs;
    }
    // Negócio ativo/perdido: etapa atual >= Call Realizada com stage_change_time no período
    if (!d.stage_change_time) return false;
    const t     = new Date(d.stage_change_time).getTime();
    const order = stageOrder[d.stage_id] ?? -1;
    return t >= sinceTs && t <= untilTs && order >= orderCallReal;
  }).length;

  // ── Vendas e Receita: negócios ganhos com won_time no período ──
  const wonDeals = funnelDeals.filter(d => {
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

    const calcArgs = [allDeals, null, stageData, budgetField.key, budgetField.mqlIds, sinceTs, untilTs];

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
