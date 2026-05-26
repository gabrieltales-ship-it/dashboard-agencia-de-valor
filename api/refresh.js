// Vercel Serverless Function — Pré-aquecimento do cache (alvo do Vercel Cron)
// Chamada: GET /api/refresh   (disparado pelo cron; ver "crons" no vercel.json)
//
// Recomputa os períodos mais usados (este mês, este ano, últimos 30 dias) e
// regrava os snapshots no Supabase, mantendo o cache quente para a 1ª visita.
//
// Proteção opcional: se CRON_SECRET estiver definido, exige o header
// Authorization: Bearer <CRON_SECRET> (o Vercel Cron envia isso automaticamente).

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.authorization !== `Bearer ${secret}`) {
    return res.status(401).json({ error: 'não autorizado' });
  }

  const origin = `https://${req.headers.host}`;
  const today  = new Date();
  const fmt    = d => d.toISOString().split('T')[0];

  const periods = [
    { period: 'month', since: fmt(new Date(today.getFullYear(), today.getMonth(), 1)), until: fmt(today) },
    { period: 'year',  since: fmt(new Date(today.getFullYear(), 0, 1)),                until: fmt(today) },
    { period: '30',    since: fmt(new Date(Date.now() - 30 * 86400000)),               until: fmt(today) },
  ];

  const results = [];
  for (const p of periods) {
    try {
      const r = await fetch(`${origin}/api/data?period=${p.period}&since=${p.since}&until=${p.until}&refresh=1`);
      results.push({ period: p.period, status: r.status });
    } catch (err) {
      results.push({ period: p.period, error: err.message });
    }
  }

  return res.status(200).json({ refreshed_at: new Date().toISOString(), results });
}
