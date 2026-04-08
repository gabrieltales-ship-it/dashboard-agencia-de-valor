# Dashboard de Performance — Agência de Valor

Dashboard de performance de campanhas Meta Ads integrado ao Pipedrive CRM.

## Arquivo principal
`index.html` — HTML single-file com CSS e JS embutidos (dados mockados por enquanto).

## Abas e funis
- **Aplicação** → campanhas identificadas por nome no Meta Ads
- **Webinário** → campanhas identificadas por nome no Meta Ads
- **Social Selling** → campanhas identificadas por nome no Meta Ads
- **Visão Geral + CRM** → consolidado de todos os funis

## Métricas por aba
- Meta Ads: Valor gasto, Leads (pixel), MQLs (evento custom), CPL, Custo/MQL
- CRM (Pipedrive): Leads, MQLs, Calls agendadas, Calls realizadas, Vendas, ROAS, Receita
- Dados manuais (planilha): Presentes no Webinário, Abordados no Social Selling

## Lógica de período
Cada métrica filtra pelo momento em que o evento aconteceu (não pela criação do lead):
- Meta Ads → `time_range: { since, until }`
- Pipedrive leads → `add_time`
- Calls agendadas → `add_time` da atividade
- Calls realizadas → `due_date` + status `done`
- Vendas → `won_time`

## Filtro de campanhas no Meta Ads (conectar por último)
Identificação por palavra-chave no nome da campanha:
- Aplicação → contém `"Sessão"`
- Webinário → contém `"Web"`
- Social Selling → contém `"Tráfego"`
- Filtrar apenas status `ACTIVE` / `IN_PROCESS` em campanhas, conjuntos e anúncios

## Estrutura do Pipedrive
- **Um único pipeline** com as mesmas etapas para todos os funis
- Funil Aplicação → leads **sem** tag WEBINARIO e **sem** tag kommo
- Funil Webinário → leads com tag `WEBINARIO`
- Funil Social Selling → leads com tag `kommo` (só chegam ao pipe após agendar call)
- Leads presentes no webinário **não entram no Pipedrive** — ficam apenas na planilha Google Sheets (número total por evento, não individual)

## Dados manuais — Google Sheets
- **Webinário:** número de presentes por evento (não individual)
- **Social Selling:** número de abordados (não individual)
- Integração via Google Sheets API (gratuita)

## Entradas totais (Visão Geral)
Usar apenas leads que entraram no CRM Pipedrive, não contagem do pixel Meta.
- Aplicação: leads sem tag WEBINARIO e sem tag kommo
- Webinário: leads com tag WEBINARIO
- Social Selling: leads com tag kommo

## Stack
- Frontend: HTML + CSS + Vanilla JS, Chart.js
- Backend: Firebase Hosting + Cloud Functions (Node.js) — ecossistema Google, integrado com Sheets
- Tokens de API guardados em variáveis de ambiente do Firebase (nunca no HTML)
- Atualização: botão manual "Atualizar Dash" (sem auto-refresh)

## Integrações a conectar (ordem de prioridade)
1. **Pipedrive API** — REST API v1, token em variável de ambiente
2. **Google Sheets API** — dados manuais (Presentes Webinário + Abordados SS)
3. **Meta Ads API** — Marketing API v19+, permissão `ads_read` (por último)

## Branding
Fonte: `'Figtree', sans-serif` (Google Fonts)

```css
--av-bg: #121212;        --av-surface: #1a1a1a;
--av-border: #333333;    --av-wm-fill: #2a2a2a;
--av-text-primary: #f4f4f4;  --av-text-secondary: #c1c1c1;
--av-text-muted: #666666;
--av-gradient-cta: linear-gradient(90deg, #FC8338 0%, #FF4A4A 100%);
--av-gradient-text: linear-gradient(90deg, #eb5d5d, #ffa01a);
--av-font: 'Figtree', sans-serif;
--av-radius-btn:6px; --av-radius-md:8px; --av-radius-lg:12px; --av-radius-xl:16px;
--av-success-bg:#1a3a1a; --av-success-text:#4ade80;
--av-warning-bg:#3a2a10; --av-warning-text:#fb923c;
--av-danger-bg:#3a1a1a;  --av-danger-text:#f87171;
--av-info-bg:#1a2a3a;    --av-info-text:#60a5fa;
```

## Padrões obrigatórios
- Interface em português brasileiro, moeda BRL (R$)
- Sem frameworks pesados (React simples OK, Angular/Vue não)
- Nunca hardcodar cores ou fontes — sempre usar variáveis CSS acima
- Nunca expor tokens de API no HTML público

## Próximos passos
1. [ ] Criar projeto Firebase e instalar Firebase CLI
2. [ ] Configurar Firebase Hosting + Cloud Functions
3. [ ] Criar Function para Pipedrive API (com token em env var)
4. [ ] Criar Function para Google Sheets API (Presentes + Abordados)
5. [ ] Substituir dados mockados do Pipedrive e Sheets pelas chamadas reais
6. [ ] Deploy público com link compartilhável
7. [ ] Criar Function para Meta Ads API (por último)
8. [ ] Separar em múltiplos arquivos (HTML / CSS / JS)
9. [ ] Responsivo para mobile
