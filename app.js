const singleForm = document.querySelector('#singleForm');
const symbolInput = document.querySelector('#symbolInput');
const autocompleteBox = document.querySelector('#autocompleteBox');
let autocompleteTimer = null;

const portfolioFile = document.querySelector('#portfolioFile');
const results = document.querySelector('#results');
const statusBox = document.querySelector('#status');
const loadingTemplate = document.querySelector('#loadingTemplate');
const loadSample = document.querySelector('#loadSample');
const portfolioSummary = document.querySelector('#portfolioSummary');
const watchlistPanel = document.querySelector('#watchlistPanel');
const watchlistItems = document.querySelector('#watchlistItems');
const clearWatchlist = document.querySelector('#clearWatchlist');

document.querySelectorAll('[data-symbol]').forEach((button) => {
  button.addEventListener('click', () => {
    symbolInput.value = button.dataset.symbol;
    singleForm.requestSubmit();
  });
});

clearWatchlist?.addEventListener('click', () => {
  localStorage.removeItem('doubleDigitWatchlist');
  renderWatchlist();
});

renderWatchlist();

singleForm.addEventListener('submit', async (event) => {
  event.preventDefault();

  const symbol = symbolInput.value.trim();
  if (!symbol) return;

  hidePortfolioSummary();
  results.innerHTML = '';

  showLoading(1, `Analyzing ${symbol.toUpperCase()}...`);

  try {
    const data = await fetchJson(`/api/analyze/${encodeURIComponent(symbol)}`);
    results.innerHTML = renderCard(data);
    setStatus(`Signal ready for ${data.symbol}. Dynamic chart loaded from ${data.symbol} price history.`, 'ok');
    loadLocalCharts();
  } catch (error) {
    results.innerHTML = '';
    setStatus(error.message, 'error');
  }
});

portfolioFile.addEventListener('change', async (event) => {
  const file = event.target.files?.[0];
  if (!file) return;

  const text = await file.text();
  const holdings = parseCsv(text);
  await analyzePortfolio(holdings);
});

loadSample.addEventListener('click', async () => {
  const holdings = [
    { symbol: 'AAPL', quantity: 4, avgPrice: 175 },
    { symbol: 'MSFT', quantity: 3, avgPrice: 390 },
    { symbol: 'RELIANCE.NS', quantity: 8, avgPrice: 1400 },
    { symbol: 'TSLA', quantity: 2, avgPrice: 210 },
    { symbol: 'TSLA', quantity: 2, avgPrice: 210 }
  ];

  await analyzePortfolio(holdings);
});

async function analyzePortfolio(holdings) {
  if (!holdings.length) {
    setStatus('CSV is empty. Use columns: symbol, quantity, avgPrice.', 'error');
    return;
  }

  results.innerHTML = '';
  showLoading(
    Math.min(holdings.length, 6),
    `Analyzing ${holdings.length} portfolio holding(s)...`
  );

  try {
    const response = await fetchJson('/api/analyze-bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ holdings })
    });

    const validItems = response.results.filter((item) => item.ok);
    const insightCard = response.portfolioAnalytics
      ? renderPortfolioIntelligence(response.portfolioAnalytics)
      : '';

    const cards = response.results
      .map((item) => (item.ok ? renderCard(item) : renderErrorCard(item)))
      .join('');

    results.innerHTML = insightCard + cards;
    renderPortfolioSummary(validItems);
    setStatus(`Portfolio analysis complete: ${response.results.length} holding(s).`, 'ok');
    loadLocalCharts();
  } catch (error) {
    results.innerHTML = '';
    hidePortfolioSummary();
    setStatus(error.message, 'error');
  }
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Request failed.');
  return data;
}

function parseCsv(text) {
  const rows = text
    .split(/\r?\n/)
    .map((row) => row.trim())
    .filter(Boolean);

  if (rows.length < 2) return [];

  const headers = rows[0]
    .split(',')
    .map((header) => header.trim().toLowerCase());

  return rows
    .slice(1)
    .map((row) => {
      const columns = row.split(',').map((cell) => cell.trim());
      const record = {};
      headers.forEach((header, index) => {
        record[header] = columns[index];
      });
      return {
        symbol: record.symbol || record.ticker || record.scrip || record.script,
        quantity: Number(record.quantity || record.qty || 0),
        avgPrice: Number(
          record.avgprice ||
          record.averageprice ||
          record.buyprice ||
          record.price ||
          0
        )
      };
    })
    .filter((row) => row.symbol);
}

function showLoading(count, message) {
  setStatus(message, 'loading');
  const node = loadingTemplate.content.firstElementChild.outerHTML;
  results.innerHTML = Array.from({ length: count }, () => node).join('');
}

function setStatus(message, type = 'neutral') {
  statusBox.textContent = message;
  statusBox.dataset.type = type;
  statusBox.classList.remove('hidden');
}

function renderCard(data) {
  const currency = data.currency || 'USD';
  const plan = data.tradePlan || {};
  const tech = data.technical || {};
  const fund = data.fundamentals || {};
  const portfolio = data.portfolio;
  const view = getModelView(data);
  const insights = buildInsights(data);
  const brief = buildDecisionBrief(data);

  return `
    <article class="glass-card result-card tone-${view.tone}">
      <div class="result-head upgraded-head">
        <div>
          <div class="symbol-row">
            <h3 class="symbol">${escapeHtml(data.symbol)}</h3>
            <button class="watch-button" type="button" data-watch-symbol="${escapeAttribute(data.symbol)}">
              ${isInWatchlist(data.symbol) ? 'Saved' : 'Save'}
            </button>
          </div>
          <p class="company">
            ${escapeHtml(data.name || '')}
            ${data.exchange ? ` · ${escapeHtml(data.exchange)}` : ''}
          </p>
        </div>

        <span class="badge ${view.tone}">${escapeHtml(view.label)}</span>
      </div>

      <div class="price-row upgraded-price">
        <strong>${money(data.price, currency)}</strong>
        <span class="${Number(data.changePercent) >= 0 ? 'positive-text' : 'negative-text'}">
          ${signedPercent(data.changePercent)} today
        </span>
      </div>

      <div class="insight-strip">
        ${insights.map((item) => `
          <div class="insight-pill ${item.tone}">
            <span>${escapeHtml(item.label)}</span>
            <strong>${escapeHtml(item.value)}</strong>
          </div>
        `).join('')}
      </div>

      ${renderDecisionKit(data, brief, view)}

      ${renderLocalChart(data.symbol)}

      <div class="score-dashboard">
        <div class="score-card hero-score">
          <span>Overall research score</span>
          <strong>${data.overallScore}/100</strong>
          <div class="meter"><span style="width:${clamp(data.overallScore, 0, 100)}%"></span></div>
        </div>
        <div class="score-card"><span>Technical</span><strong>${tech.score ?? '—'}/100</strong></div>
        <div class="score-card"><span>Fundamental</span><strong>${fund.score ?? '—'}/100</strong></div>
        <div class="score-card"><span>Risk</span><strong>${escapeHtml(data.risk || '—')}</strong></div>
        <div class="score-card"><span>Confidence</span><strong>${escapeHtml(data.confidence || '—')}</strong></div>
      </div>

      <p class="section-title">Entry / exit framework</p>
      <div class="plan-grid">
        <div class="mini-tile"><span>Entry zone</span><strong>${range(plan.entryLow, plan.entryHigh, currency)}</strong></div>
        <div class="mini-tile"><span>Breakout watch</span><strong>${money(plan.breakoutBuyAbove, currency)}</strong></div>
        <div class="mini-tile"><span>Invalidation</span><strong>${money(plan.stopLoss, currency)}</strong></div>
        <div class="mini-tile"><span>Targets to monitor</span><strong>${money(plan.target1, currency)} / ${money(plan.target2, currency)}</strong></div>
      </div>

      ${portfolio ? renderPortfolio(portfolio, currency) : ''}

      <p class="section-title">Why this score?</p>
      <ul class="reason-list friendly-reasons">
        ${[...(tech.reasons || []), ...(fund.reasons || [])]
          .slice(0, 8)
          .map((reason) => `<li>${escapeHtml(reason)}</li>`)
          .join('')}
      </ul>

      <p class="section-title">Key levels</p>
      <div class="metrics-grid">
        <div class="mini-tile"><span>SMA 20</span><strong>${money(tech.indicators?.sma20, currency)}</strong></div>
        <div class="mini-tile"><span>SMA 50</span><strong>${money(tech.indicators?.sma50, currency)}</strong></div>
        <div class="mini-tile"><span>SMA 200</span><strong>${money(tech.indicators?.sma200, currency)}</strong></div>
        <div class="mini-tile"><span>RSI 14</span><strong>${number(tech.indicators?.rsi14)}</strong></div>
        <div class="mini-tile"><span>Support</span><strong>${money(plan.support, currency)}</strong></div>
        <div class="mini-tile"><span>Resistance</span><strong>${money(plan.resistance, currency)}</strong></div>
      </div>

      <div class="safety-note">
        This is a rule-based educational view, not a personalized recommendation. Check your time horizon, risk tolerance, position size, and latest company news before acting.
      </div>
    </article>
  `;
}

function renderDecisionKit(data, brief, view) {
  return `
    <section class="decision-kit">
      <div class="decision-kicker">Double Digit decision kit</div>
      <div class="decision-top">
        <div>
          <h4>${escapeHtml(brief.headline)}</h4>
          <p>${escapeHtml(brief.simpleTake)}</p>
        </div>
        <div class="model-chip ${view.tone}">
          <span>Model view</span>
          <strong>${escapeHtml(view.label)}</strong>
        </div>
      </div>

      <div class="case-grid">
        <div class="case-card bull"><span>Bull case</span><p>${escapeHtml(brief.bullCase)}</p></div>
        <div class="case-card base"><span>Base case</span><p>${escapeHtml(brief.baseCase)}</p></div>
        <div class="case-card bear"><span>Bear case</span><p>${escapeHtml(brief.bearCase)}</p></div>
      </div>

      <div class="checklist-card">
        <span>Before acting, check</span>
        <ul>
          ${brief.checklist.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}
        </ul>
      </div>
    </section>
  `;
}

function getModelView(data) {
  const rec = String(data.recommendation || '').toUpperCase();
  const risk = String(data.risk || '').toLowerCase();

  if (rec === 'BUY' && risk !== 'high') {
    return { label: 'Constructive setup', tone: 'buy' };
  }

  if (rec === 'BUY') {
    return { label: 'Positive but volatile', tone: 'hold' };
  }

  if (rec === 'SELL') {
    return { label: 'Risk elevated', tone: 'sell' };
  }

  return { label: 'Watchlist / wait', tone: 'hold' };
}

function buildInsights(data) {
  const tech = data.technical || {};
  const fund = data.fundamentals || {};
  const indicators = tech.indicators || {};
  const rsi = Number(indicators.rsi14);

  const trend = Number(data.price) > Number(indicators.sma200)
    ? { label: 'Trend', value: 'Above 200 DMA', tone: 'good' }
    : { label: 'Trend', value: 'Below / unclear', tone: 'warn' };

  const valuationMetric = fund.metrics?.trailingPE;
  const valuation = Number.isFinite(Number(valuationMetric))
    ? Number(valuationMetric) > 45
      ? { label: 'Valuation', value: 'Looks expensive', tone: 'warn' }
      : { label: 'Valuation', value: 'Not stretched', tone: 'good' }
    : { label: 'Valuation', value: 'Limited data', tone: 'neutral' };

  const momentum = Number.isFinite(rsi)
    ? rsi > 72
      ? { label: 'Momentum', value: 'Overheated RSI', tone: 'warn' }
      : rsi >= 45 && rsi <= 65
        ? { label: 'Momentum', value: 'Healthy RSI', tone: 'good' }
        : { label: 'Momentum', value: 'Mixed RSI', tone: 'neutral' }
    : { label: 'Momentum', value: 'RSI unavailable', tone: 'neutral' };

  return [trend, momentum, valuation];
}

function buildDecisionBrief(data) {
  const rec = String(data.recommendation || '').toUpperCase();
  const tech = data.technical || {};
  const fund = data.fundamentals || {};
  const plan = data.tradePlan || {};
  const score = data.overallScore ?? '—';
  const techScore = tech.score ?? '—';
  const fundScore = fund.score ?? '—';
  const risk = data.risk || 'Unknown';

  if (rec === 'BUY') {
    return {
      headline: `${data.symbol} has a constructive research setup.` ,
      simpleTake: `The model score is ${score}/100 with technical strength at ${techScore}/100. Treat this as a candidate to research further, not a blind buy signal.`,
      bullCase: 'Trend and momentum are supportive, and the setup may improve if price holds key moving averages.',
      baseCase: `Best reviewed near the entry zone or after a clean breakout above ${formatPlain(plan.breakoutBuyAbove)}.`,
      bearCase: `The view weakens if price breaks the invalidation level near ${formatPlain(plan.stopLoss)} or if fundamentals deteriorate.`,
      checklist: [
        'Is the stock near your planned entry zone, or are you chasing?',
        'Is position size small enough if the stop-loss hits?',
        'Have you checked latest earnings/news outside this app?',
        `Risk label is ${risk}; does that match your risk tolerance?`
      ]
    };
  }

  if (rec === 'SELL') {
    return {
      headline: `${data.symbol} needs caution before fresh capital.`,
      simpleTake: `The model score is ${score}/100 and the current risk-reward is not attractive. Existing holders should review thesis and risk limits.`,
      bullCase: 'A reversal can improve if price reclaims key moving averages with stronger volume.',
      baseCase: 'Wait for confirmation rather than averaging into weakness.',
      bearCase: 'Weak momentum or fundamentals can create further downside if support breaks.',
      checklist: [
        'Has your original investment thesis changed?',
        'Is the stock below important support or moving averages?',
        'Would you buy this today if you did not already own it?',
        'Have you defined the invalidation level clearly?'
      ]
    };
  }

  return {
    headline: `${data.symbol} is a wait-and-watch candidate.`,
    simpleTake: `The model is neutral at ${score}/100. This is not a clean opportunity or a clear exit based on current signals.`,
    bullCase: 'A breakout above resistance with improving momentum could improve the setup.',
    baseCase: `Monitor support near ${formatPlain(plan.support)} and resistance near ${formatPlain(plan.resistance)}.`,
    bearCase: 'A support break or weaker fundamentals would move this toward a caution view.',
    checklist: [
      'What specific trigger would make this more attractive?',
      'What specific level would invalidate the setup?',
      `Fundamental score is ${fundScore}/100; is that enough for your time horizon?`,
      'Can you wait for confirmation instead of forcing a trade?'
    ]
  };
}

function formatPlain(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return '—';
  return Number(value).toLocaleString('en-IN', { maximumFractionDigits: 2 });
}

function renderLocalChart(symbol) {
  const safeSymbol = escapeAttribute(symbol);

  return `
    <section class="chart-box">
      <div class="chart-head">
        <span>Dynamic price chart</span>
        <strong>${escapeHtml(symbol)}</strong>
      </div>
      <div class="local-chart-shell">
        <div class="local-chart" data-symbol="${safeSymbol}"></div>
        <div class="chart-caption">Candlestick chart generated from ${escapeHtml(symbol)} historical price data.</div>
      </div>
    </section>
  `;
}

async function loadLocalCharts() {
  const chartNodes = document.querySelectorAll('.local-chart');

  chartNodes.forEach(async (node) => {
    if (node.dataset.loaded === 'true') return;
    const symbol = node.dataset.symbol;
    if (!symbol) return;

    node.dataset.loaded = 'true';
    node.innerHTML = '<div class="chart-loading">Loading chart data...</div>';

    try {
      const response = await fetchJson(`/api/chart/${encodeURIComponent(symbol)}`);
      drawCandlestickChart(node, response.candles || []);
    } catch (error) {
      node.innerHTML = `<div class="chart-error">${escapeHtml(error.message || 'Could not load chart.')}</div>`;
    }
  });
}

function drawCandlestickChart(container, candles) {
  if (!window.LightweightCharts) {
    container.innerHTML = '<div class="chart-error">Chart library did not load. Check internet connection and refresh.</div>';
    return;
  }

  if (!candles.length) {
    container.innerHTML = '<div class="chart-error">No candle data available for this stock.</div>';
    return;
  }

  container.innerHTML = '';

  const chart = LightweightCharts.createChart(container, {
    width: container.clientWidth,
    height: 440,
    layout: {
      background: { color: '#050505' },
      textColor: 'rgba(255,255,255,0.72)'
    },
    grid: {
      vertLines: { color: 'rgba(255,255,255,0.06)' },
      horzLines: { color: 'rgba(255,255,255,0.06)' }
    },
    crosshair: {
      mode: LightweightCharts.CrosshairMode.Normal
    },
    rightPriceScale: {
      borderColor: 'rgba(255,255,255,0.12)'
    },
    timeScale: {
      borderColor: 'rgba(255,255,255,0.12)',
      timeVisible: false
    }
  });

  const candleSeries = chart.addCandlestickSeries({
    upColor: '#77f2a1',
    downColor: '#ff6b81',
    borderUpColor: '#77f2a1',
    borderDownColor: '#ff6b81',
    wickUpColor: '#77f2a1',
    wickDownColor: '#ff6b81'
  });

  candleSeries.setData(
    candles.map((c) => ({
      time: c.time,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close
    }))
  );

  const sma20Data = calculateSmaLine(candles, 20);
  if (sma20Data.length) {
    const smaSeries = chart.addLineSeries({
      color: '#8ab4ff',
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: true
    });
    smaSeries.setData(sma20Data);
  }

  const volumeSeries = chart.addHistogramSeries({
    color: 'rgba(255,255,255,0.24)',
    priceFormat: { type: 'volume' },
    priceScaleId: ''
  });

  volumeSeries.priceScale().applyOptions({
    scaleMargins: { top: 0.82, bottom: 0 }
  });

  volumeSeries.setData(
    candles.map((c) => ({
      time: c.time,
      value: c.volume || 0,
      color: c.close >= c.open ? 'rgba(33,201,151,0.28)' : 'rgba(255,77,103,0.28)'
    }))
  );

  chart.timeScale().fitContent();

  const resizeObserver = new ResizeObserver(() => {
    chart.applyOptions({ width: container.clientWidth });
  });
  resizeObserver.observe(container);
}

function calculateSmaLine(candles, period) {
  const output = [];

  for (let i = period - 1; i < candles.length; i += 1) {
    const slice = candles.slice(i - period + 1, i + 1);
    const averageClose = slice.reduce((sum, item) => sum + item.close, 0) / period;
    output.push({ time: candles[i].time, value: Number(averageClose.toFixed(2)) });
  }

  return output;
}

function renderPortfolioIntelligence(analytics) {
  return `
    <article class="glass-card result-card portfolio-intel-card">
      <div class="result-head">
        <div>
          <h3 class="symbol">Portfolio Intelligence</h3>
          <p class="company">Risk, concentration, signal mix and next actions</p>
        </div>
        <span class="badge hold">AI VIEW</span>
      </div>

      <div class="portfolio-score-row">
        <div><span>Portfolio health</span><strong>${analytics.healthScore}/100</strong></div>
        <div><span>Risk level</span><strong>${escapeHtml(analytics.riskLevel)}</strong></div>
        <div><span>Top holding weight</span><strong>${number(analytics.topHoldingWeight)}%</strong></div>
      </div>

      <p class="section-title">Executive summary</p>
      <ul class="reason-list">${(analytics.summary || []).map((line) => `<li>${escapeHtml(line)}</li>`).join('')}</ul>

      <p class="section-title">Suggested next actions</p>
      <ul class="reason-list">${(analytics.nextActions || []).map((line) => `<li>${escapeHtml(line)}</li>`).join('')}</ul>
    </article>
  `;
}

function renderPortfolio(portfolio, currency) {
  return `
    <p class="section-title">Your position</p>
    <div class="metrics-grid">
      <div class="mini-tile"><span>Quantity</span><strong>${number(portfolio.quantity)}</strong></div>
      <div class="mini-tile"><span>Avg price</span><strong>${money(portfolio.avgPrice, currency)}</strong></div>
      <div class="mini-tile"><span>Current value</span><strong>${money(portfolio.currentValue, currency)}</strong></div>
      <div class="mini-tile"><span>P&L</span><strong>${money(portfolio.pnl, currency)} (${signedPercent(portfolio.pnlPercent)})</strong></div>
    </div>
  `;
}

function renderErrorCard(item) {
  return `
    <article class="glass-card result-card">
      <div class="result-head">
        <div>
          <h3 class="symbol">${escapeHtml(item.symbol || 'Unknown')}</h3>
          <p class="company">Could not analyze this row</p>
        </div>
        <span class="badge sell">ERROR</span>
      </div>
      <p class="section-title">Message</p>
      <ul class="reason-list"><li>${escapeHtml(item.error || 'Unknown error')}</li></ul>
    </article>
  `;
}

function renderPortfolioSummary(items) {
  const totals = items.reduce(
    (acc, item) => {
      const portfolio = item.portfolio || {};
      acc.value += Number(portfolio.currentValue || 0);
      acc.pnl += Number(portfolio.pnl || 0);
      acc[item.recommendation] = (acc[item.recommendation] || 0) + 1;
      acc.currency = item.currency || acc.currency || 'USD';
      return acc;
    },
    { value: 0, pnl: 0, BUY: 0, HOLD: 0, SELL: 0, currency: 'USD' }
  );

  document.querySelector('#totalValue').textContent = money(totals.value, totals.currency);
  document.querySelector('#totalPnl').textContent = money(totals.pnl, totals.currency);
  document.querySelector('#signalMix').textContent = `${totals.BUY} / ${totals.HOLD} / ${totals.SELL}`;
  portfolioSummary.hidden = false;
}

function hidePortfolioSummary() {
  portfolioSummary.hidden = true;
}

function money(value, currency = 'USD') {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return '—';

  try {
    return new Intl.NumberFormat('en-IN', {
      style: 'currency',
      currency,
      maximumFractionDigits: 2
    }).format(value);
  } catch {
    return `${currency} ${Number(value).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
  }
}

function number(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return '—';
  return Number(value).toLocaleString('en-IN', { maximumFractionDigits: 2 });
}

function signedPercent(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return '—';
  const n = Number(value);
  const sign = n > 0 ? '+' : '';
  return `${sign}${n.toFixed(2)}%`;
}

function range(low, high, currency) {
  if (low === null || low === undefined || high === null || high === undefined) return 'Wait / avoid';
  return `${money(low, currency)} – ${money(high, currency)}`;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Number(value || 0)));
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function escapeAttribute(value) {
  return escapeHtml(value).replaceAll('`', '&#096;');
}


function getWatchlist() {
  try {
    return JSON.parse(localStorage.getItem('doubleDigitWatchlist') || '[]');
  } catch {
    return [];
  }
}

function saveWatchlist(items) {
  localStorage.setItem('doubleDigitWatchlist', JSON.stringify(items));
}

function isInWatchlist(symbol) {
  return getWatchlist().some((item) => item.symbol === symbol);
}

function toggleWatchlist(symbol) {
  const items = getWatchlist();
  const exists = items.some((item) => item.symbol === symbol);

  const nextItems = exists
    ? items.filter((item) => item.symbol !== symbol)
    : [{ symbol, addedAt: new Date().toISOString() }, ...items].slice(0, 20);

  saveWatchlist(nextItems);
  renderWatchlist();

  document.querySelectorAll(`[data-watch-symbol="${cssEscape(symbol)}"]`).forEach((button) => {
    button.textContent = exists ? 'Save' : 'Saved';
  });
}

function renderWatchlist() {
  const items = getWatchlist();

  if (!watchlistPanel || !watchlistItems) return;

  watchlistPanel.hidden = items.length === 0;

  watchlistItems.innerHTML = items
    .map((item) => `
      <button type="button" class="watchlist-chip" data-watch-open="${escapeAttribute(item.symbol)}">
        ${escapeHtml(item.symbol)}
      </button>
    `)
    .join('');

  document.querySelectorAll('[data-watch-open]').forEach((button) => {
    button.addEventListener('click', () => {
      symbolInput.value = button.dataset.watchOpen;
      singleForm.requestSubmit();
    });
  });
}

function cssEscape(value) {
  return String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"');
}

document.addEventListener('click', (event) => {
  const watchButton = event.target.closest('[data-watch-symbol]');
  if (!watchButton) return;
  toggleWatchlist(watchButton.dataset.watchSymbol);
});

async function fetchAutocompleteSuggestions(query) {
  try {
    const response = await fetch(`/api/search?q=${encodeURIComponent(query)}`);
    const data = await response.json();
    return data.results || [];
  } catch (error) {
    console.log('Autocomplete failed:', error);
    return [];
  }
}

function renderAutocompleteSuggestions(resultsList) {
  if (!resultsList.length) {
    autocompleteBox.classList.remove('active');
    autocompleteBox.innerHTML = '';
    return;
  }

  autocompleteBox.innerHTML = resultsList
    .map((item) => `
      <div class="autocomplete-item" data-symbol="${escapeAttribute(item.symbol)}">
        <div class="autocomplete-symbol">${escapeHtml(item.symbol)}</div>
        <div class="autocomplete-name">${escapeHtml(item.name)}</div>
        <div class="autocomplete-meta">${escapeHtml(item.exchange)} · ${escapeHtml(item.type)}</div>
      </div>
    `)
    .join('');

  autocompleteBox.classList.add('active');

  document.querySelectorAll('.autocomplete-item').forEach((item) => {
    item.addEventListener('click', () => {
      symbolInput.value = item.dataset.symbol;
      autocompleteBox.classList.remove('active');
      autocompleteBox.innerHTML = '';
      singleForm.requestSubmit();
    });
  });
}

symbolInput.addEventListener('input', () => {
  const query = symbolInput.value.trim();
  clearTimeout(autocompleteTimer);

  if (query.length < 2) {
    autocompleteBox.classList.remove('active');
    autocompleteBox.innerHTML = '';
    return;
  }

  autocompleteTimer = setTimeout(async () => {
    const resultsList = await fetchAutocompleteSuggestions(query);
    renderAutocompleteSuggestions(resultsList);
  }, 250);
});

document.addEventListener('click', (event) => {
  if (!autocompleteBox.contains(event.target) && event.target !== symbolInput) {
    autocompleteBox.classList.remove('active');
  }
});
