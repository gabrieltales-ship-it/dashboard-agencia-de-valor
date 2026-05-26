// Vercel Serverless Function — Camada de cache (Supabase)
// Chamada: GET /api/data?period=month&since=2026-05-01&until=2026-05-26[&refresh=1]
//
// Modelo "cache instantâneo + refresh":
//   - sem refresh  → devolve o último snapshot gravado no Supabase (rápido)
//   - refresh=1    → busca Meta+Pipedrive+Sheets ao vivo, grava no Supabase e devolve
//   - cache vazio  → cai automaticamente no caminho ao vivo
//
// O payload guardado tem a forma { pipedrive, meta, sheets, errors }, espelhando
// as três funções existentes — assim o frontend só precisa aplicar cada parte.

const SUPA_URL = process.env.SUPABASE_URL;
const SUPA_KEY = process.env.SUPABASE_SERVICE_KEY;
const TABLE    = 'dashboard_snapshots';

function supaConfigured() {
  return Boolean(SUPA_URL && SUPA_KEY);
}

function supaHeaders(extra = {}) {
  return {
    apikey: SUPA_KEY,
    Authorization: `Bearer ${SUPA_KEY}`,
    'Content-Type': 'application/json',
    ...extra,
  };
}

// ─── Lê um snapshot por chave de período ──────────────────────────────────────

async function readSnapshot(key) {
  if (!supaConfigured()) return null;
  const url = `${SUPA_URL}/rest/v1/${TABLE}?period_key=eq.${encodeURIComponent(key)}&select=*&limit=1`;
  const res = await fetch(url, { headers: supaHeaders() });
  if (!res.ok) return null;
  const rows = await res.json().catch(() => []);
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

// ─── Grava (upsert) um snapshot ───────────────────────────────────────────────

async function writeSnapshot(key, since, until, payload) {
  if (!supaConfigured()) return;
  const url = `${SUPA_URL}/rest/v1/${TABLE}`;
  const body = [{
    period_key: key,
    since,
    until,
    payload,
    updated_at: new Date().toISOString(),
  }];
  await fetch(url, {
    method: 'POST',
    headers: supaHeaders({ Prefer: 'resolution=merge-duplicates,return=minimal' }),
    body: JSON.stringify(body),
  });
}

// ─── Busca as três fontes ao vivo (em paralelo, isolando falhas) ──────────────

async function fetchLive(origin, since, until) {
  const q = `since=${since}&until=${until}`;
  const get = path => fetch(`${origin}${path}?${q}`).then(r => r.json());

  const [pipe, meta, sheets] = await Promise.allSettled([
    get('/api/pipedrive'),
    get('/api/meta'),
    get('/api/sheets'),
  ]);

  const ok = r => (r.status === 'fulfilled' && !r.value?.error ? r.value : null);
  const errOf = r => (r.status === 'fulfilled' ? r.value?.error || null : r.reason?.message || 'falha de rede');

  return {
    pipedrive: ok(pipe),
    meta:      ok(meta),
    sheets:    ok(sheets),
    errors: {
      pipedrive: errOf(pipe),
      meta:      errOf(meta),
      sheets:    errOf(sheets),
    },
  };
}

// ─── Monta a chave de cache estável a partir do período ───────────────────────
// Presets (month/year/N) usam o próprio rótulo; custom usa o intervalo exato.

function cacheKey(period, since, until) {
  if (!period || period === 'custom') return `custom_${since}_${until}`;
  return period;
}

// ─── Handler principal ────────────────────────────────────────────────────────

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const { since, until, period = 'custom', refresh } = req.query;
  if (!since || !until) {
    return res.status(400).json({ error: 'Parâmetros since e until são obrigatórios (YYYY-MM-DD)' });
  }

  const key    = cacheKey(period, since, until);
  const origin = `https://${req.headers.host}`;

  try {
    // Caminho rápido: devolve o snapshot do cache (salvo se refresh=1)
    if (!refresh) {
      const snap = await readSnapshot(key);
      if (snap) {
        return res.status(200).json({
          cached: true,
          updated_at: snap.updated_at,
          period: { since, until },
          data: snap.payload,
        });
      }
    }

    // Recomputa ao vivo e grava no cache
    const payload = await fetchLive(origin, since, until);
    await writeSnapshot(key, since, until, payload);

    return res.status(200).json({
      cached: false,
      updated_at: new Date().toISOString(),
      period: { since, until },
      data: payload,
    });

  } catch (err) {
    console.error('[data]', err.message);
    return res.status(500).json({ error: err.message });
  }
}
