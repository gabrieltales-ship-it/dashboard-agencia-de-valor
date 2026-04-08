// Vercel Serverless Function — Google Sheets API
// Chamada: GET /api/sheets?since=2026-01-01&until=2026-01-31
// Planilha contém: data do evento | presentes (webinário) | abordados (SS)

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const { since, until } = req.query;
  const sheetsKey = process.env.GOOGLE_SHEETS_KEY;
  const spreadsheetId = process.env.SPREADSHEET_ID;

  if (!sheetsKey || !spreadsheetId) {
    return res.status(500).json({ error: 'Credenciais Google Sheets não configuradas' });
  }

  // TODO: implementar chamadas reais ao Google Sheets
  // Por enquanto retorna estrutura esperada com dados mockados
  return res.status(200).json({
    source: 'google_sheets',
    period: { since, until },
    webinario: {
      presentes: 389   // número total de presentes nos webinários do período
    },
    social_selling: {
      abordados: 420   // número total de abordados no período
    }
  });
}
