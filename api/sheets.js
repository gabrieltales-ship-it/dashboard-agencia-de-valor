// Vercel Serverless Function — Google Sheets API
// Chamada: GET /api/sheets?since=2026-01-01&until=2026-04-30
//
// Estrutura esperada na planilha:
//   Aba "Webinário"    → linha 1: cabeçalho | col A: Data (AAAA-MM-DD) | col B: Leads | col C: Presentes
//   Aba "Social Selling" → linha 1: cabeçalho | col A: Data (AAAA-MM-DD) | col B: Abordados

const SHEETS_BASE = 'https://sheets.googleapis.com/v4/spreadsheets';

async function getRange(spreadsheetId, range, apiKey) {
  const url = `${SHEETS_BASE}/${spreadsheetId}/values/${encodeURIComponent(range)}?key=${apiKey}`;
  const res  = await fetch(url);
  const json = await res.json();
  if (json.error) throw new Error(`Sheets erro (${range}): ${json.error.message}`);
  return json.values || [];
}

function sumInPeriod(rows, dateColIdx, valueColIdx, sinceTs, untilTs) {
  let total = 0;
  for (const row of rows) {
    const dateStr = row[dateColIdx];
    const rawVal  = row[valueColIdx];
    if (!dateStr || !rawVal) continue;
    const t = new Date(dateStr).getTime();
    if (isNaN(t) || t < sinceTs || t > untilTs) continue;
    const n = parseFloat(String(rawVal).replace(',', '.'));
    if (isFinite(n)) total += n;
  }
  return total;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const apiKey        = process.env.GOOGLE_SHEETS_KEY;
  const spreadsheetId = process.env.SPREADSHEET_ID;

  if (!apiKey || !spreadsheetId) {
    return res.status(500).json({ error: 'Credenciais Google Sheets não configuradas' });
  }

  const { since, until } = req.query;
  if (!since || !until) {
    return res.status(400).json({ error: 'Parâmetros since e until são obrigatórios (AAAA-MM-DD)' });
  }

  const sinceTs = new Date(since).getTime();
  const untilTs = new Date(until + 'T23:59:59').getTime();

  try {
    // Lê as duas abas em paralelo (ignora a linha de cabeçalho — range começa na linha 2)
    const [webRows, socRows] = await Promise.all([
      getRange(spreadsheetId, 'Webinário!A2:C',      apiKey),
      getRange(spreadsheetId, 'Social Selling!A2:C', apiKey)
    ]);

    const leads_web   = sumInPeriod(webRows, 0, 1, sinceTs, untilTs);  // col B
    const presentes   = sumInPeriod(webRows, 0, 2, sinceTs, untilTs);  // col C
    const abordados   = sumInPeriod(socRows, 0, 1, sinceTs, untilTs);  // col B
    const seguidores  = sumInPeriod(socRows, 0, 2, sinceTs, untilTs);  // col C

    return res.status(200).json({
      source: 'google_sheets',
      period: { since, until },
      webinario: {
        leads:     leads_web,
        presentes: presentes
      },
      social_selling: {
        abordados:  abordados,
        seguidores: seguidores
      }
    });

  } catch (err) {
    console.error('[sheets]', err.message);
    return res.status(500).json({ error: err.message });
  }
}
