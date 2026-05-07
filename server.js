import express from 'express';
import cors from 'cors';
import YahooFinance from 'yahoo-finance2';
import path from 'path';
import { fileURLToPath } from 'url';

const yahooFinance = new YahooFinance({
  suppressNotices: ['yahooSurvey', 'ripHistorical']
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const TECH_WEIGHT = 0.58;
const FUND_WEIGHT = 0.42;

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, app: 'Double Digit', timestamp: new Date().toISOString() });
});

app.get('/api/search', async (req, res) => {
  try {
    const query = String(req.query.q || '').trim();
    if (query.length < 2) return res.json({ results: [] });

    const search = await yahooFinance.search(query);

    const results = (search?.quotes || [])
      .filter((q) => q.symbol && ['EQUITY', 'ETF'].includes(q.quoteType || q.typeDisp))
      .slice(0, 12)
      .map((q) => ({
        symbol: q.symbol,
        name: q.shortname || q.longname || q.name || q.symbol,
        exchange: q.exchangeDisplay || q.exchange || '',
        type: q.quoteType || q.typeDisp || ''
      }));

    res.json({ results });
  } catch (error) {
    console.log('Search error:', error.message);
    res.status(400).json({ error: 'Unable to search stocks.' });
  }
});

app.get('/api/analyze/:symbol', async (req, res) => {
  try {
    const symbol = await resolveTicker(req.params.symbol);
    const analysis = await analyzeStock(symbol);
    res.json(analysis);
  } catch (error) {
    res.status(400).json({ error: error.message || 'Unable to analyze this stock.' });
  }
});

app.get('/api/chart/:symbol', async (req, res) => {
  try {
    const symbol = await resolveTicker(req.params.symbol);
    const candles = await fetchCandles(symbol, 18);

    if (!candles.length) {
      return res.status(400).json({ error: `No chart data found for ${symbol}.` });
    }

    res.json({
      symbol,
      candles: candles.map((c) => ({
        time: toChartDate(c.date),
        open: round(c.open),
        high: round(c.high),
        low: round(c.low),
        close: round(c.close),
        volume: Number(c.volume || 0)
      }))
    });
  } catch (error) {
    res.status(400).json({ error: error.message || 'Unable to load chart data.' });
  }
});

app.post('/api/analyze-bulk', async (req, res) => {
  try {
    const holdings = Array.isArray(req.body?.holdings) ? req.body.holdings : [];
    if (!holdings.length) {
      return res.status(400).json({ error: 'Send holdings as { holdings: [{ symbol, quantity, avgPrice }] }' });
    }

    const results = [];
    for (const rawHolding of holdings.slice(0, 50)) {
      try {
        const holding = normalizeHolding(rawHolding);
        const resolvedSymbol = await resolveTicker(holding.symbol);
        const analysis = await analyzeStock(resolvedSymbol, { ...holding, symbol: resolvedSymbol });
        results.push({ ok: true, ...analysis });
      } catch (error) {
        results.push({
          ok: false,
          symbol: String(rawHolding.symbol || '').toUpperCase(),
          error: error.message || 'Failed to analyze this holding.'
        });
      }
    }

    const portfolioAnalytics = buildPortfolioAnalytics(results.filter((item) => item.ok));
    res.json({ count: results.length, results, portfolioAnalytics });
  } catch (error) {
    res.status(500).json({ error: error.message || 'Bulk analysis failed.' });
  }
});

async function analyzeStock(symbol, holding = null) {
  if (!symbol) throw new Error('Please enter a valid ticker symbol.');

  const candles = await fetchCandles(symbol, 12);
  if (candles.length < 60) {
    throw new Error(`Not enough price history for ${symbol}. Try a more liquid or correctly suffixed ticker.`);
  }

  const quotePromise = yahooFinance.quote(symbol);
  const summaryPromise = yahooFinance.quoteSummary(symbol, {
    modules: ['price', 'summaryDetail', 'defaultKeyStatistics', 'financialData']
  }).catch(() => null);

  const [quote, summary] = await Promise.all([quotePromise, summaryPromise]);

  const closes = candles.map((c) => c.close);
  const volumes = candles.map((c) => c.volume || 0);
  const lastCandle = candles[candles.length - 1];

  const price = numberOrNull(quote?.regularMarketPrice) ?? numberOrNull(summary?.price?.regularMarketPrice) ?? lastCandle.close;
  const previousClose = numberOrNull(quote?.regularMarketPreviousClose) ?? candles[candles.length - 2]?.close ?? null;
  const changePercent = previousClose ? ((price - previousClose) / previousClose) * 100 : null;

  const indicators = {
    sma20: sma(closes, 20),
    sma50: sma(closes, 50),
    sma200: sma(closes, 200),
    rsi14: rsi(closes, 14),
    macd: macd(closes),
    atr14: atr(candles, 14),
    support60: rollingLow(candles, 60),
    resistance60: rollingHigh(candles, 60),
    avgVolume20: sma(volumes, 20)
  };

  const technical = scoreTechnical(price, indicators, quote?.regularMarketVolume || lastCandle.volume);
  const fundamentals = scoreFundamentals(summary);
  const overallScore = clamp(Math.round(technical.score * TECH_WEIGHT + fundamentals.score * FUND_WEIGHT), 0, 100);
  const recommendation = classifyRecommendation(overallScore, technical.score, price, indicators.sma200);
  const tradePlan = buildTradePlan(recommendation, price, indicators);
  const risk = riskLevel(price, indicators.atr14);
  const exchange = quote?.fullExchangeName || quote?.exchange || summary?.price?.exchangeName || summary?.price?.exchange || null;
  const aiNarrative = buildAiNarrative({ symbol, recommendation, overallScore, technical, fundamentals, tradePlan, risk, price, indicators });
  const portfolio = holding ? buildPortfolioView(holding, price) : null;

  return {
    symbol,
    name: quote?.longName || quote?.shortName || summary?.price?.longName || symbol,
    exchange,
    currency: quote?.currency || summary?.price?.currency || 'USD',
    asOf: new Date().toISOString(),
    price: round(price),
    previousClose: round(previousClose),
    changePercent: round(changePercent),
    recommendation,
    overallScore,
    risk,
    confidence: confidenceLabel(candles.length, fundamentals.completeness),
    technical: {
      score: technical.score,
      indicators: roundObject(indicators),
      reasons: technical.reasons
    },
    fundamentals: {
      score: fundamentals.score,
      completeness: fundamentals.completeness,
      metrics: roundObject(fundamentals.metrics),
      reasons: fundamentals.reasons
    },
    tradePlan,
    aiNarrative,
    portfolio,
    disclaimer: 'Educational, rule-based signal only. Do your own research and consult a registered adviser before acting.'
  };
}

async function fetchCandles(symbol, monthsBack = 12) {
  const end = new Date();
  const start = new Date();
  start.setMonth(end.getMonth() - monthsBack);

  const history = await yahooFinance.historical(symbol, {
    period1: start,
    period2: end,
    interval: '1d'
  });

  return sanitizeCandles(history);
}

async function resolveTicker(input) {
  const query = String(input || '').trim();
  if (!query) return '';

  if (query.includes('.') || query.includes(':')) return normalizeSymbol(query);

  try {
    const search = await yahooFinance.search(query);
    const validQuotes = (search?.quotes || []).filter((q) =>
      q.symbol && (q.quoteType === 'EQUITY' || q.typeDisp === 'Equity' || q.quoteType === 'ETF' || q.typeDisp === 'ETF')
    );

    if (!validQuotes.length) return normalizeSymbol(query);

    const exactMatch = validQuotes.find((q) => String(q.symbol).toUpperCase() === query.toUpperCase());
    if (exactMatch?.symbol) return normalizeSymbol(exactMatch.symbol);

    const nseMatch = validQuotes.find((q) => q.exchange === 'NSI' || q.exchangeDisplay === 'NSE');
    if (nseMatch?.symbol) return normalizeSymbol(nseMatch.symbol);

    const bseMatch = validQuotes.find((q) => q.exchange === 'BSE' || q.exchangeDisplay === 'BSE');
    if (bseMatch?.symbol) return normalizeSymbol(bseMatch.symbol);

    return normalizeSymbol(validQuotes[0].symbol);
  } catch (error) {
    console.log('Ticker search failed:', error.message);
    return normalizeSymbol(query);
  }
}

function normalizeSymbol(symbol) {
  return String(symbol || '').trim().replace(/\s+/g, '').toUpperCase();
}

function normalizeHolding(raw) {
  const symbol = String(raw.symbol || raw.ticker || raw.scrip || raw.script || '').trim();
  const quantity = Number(raw.quantity || raw.qty || 0) || 0;
  const avgPrice = Number(raw.avgPrice || raw.averagePrice || raw.buyPrice || raw.price || 0) || 0;
  if (!symbol) throw new Error('Missing symbol in one portfolio row.');
  return { symbol, quantity, avgPrice };
}

function sanitizeCandles(history = []) {
  return history
    .filter((d) => d && d.close && d.high && d.low)
    .map((d) => ({
      date: new Date(d.date),
      open: Number(d.open),
      high: Number(d.high),
      low: Number(d.low),
      close: Number(d.close),
      volume: Number(d.volume || 0)
    }))
    .sort((a, b) => a.date - b.date);
}

function toChartDate(date) {
  return new Date(date).toISOString().split('T')[0];
}

function numberOrNull(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'object' && 'raw' in value) return Number(value.raw);
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function pickNumber(...values) {
  for (const value of values) {
    const n = numberOrNull(value);
    if (n !== null && Number.isFinite(n)) return n;
  }
  return null;
}

function average(values) {
  const clean = values.filter((v) => Number.isFinite(v));
  if (!clean.length) return null;
  return clean.reduce((sum, v) => sum + v, 0) / clean.length;
}

function sma(values, period) {
  if (!Array.isArray(values) || values.length < period) return null;
  return average(values.slice(-period));
}

function emaSeries(values, period) {
  const out = Array(values.length).fill(null);
  if (values.length < period) return out;
  const k = 2 / (period + 1);
  let prev = average(values.slice(0, period));
  out[period - 1] = prev;
  for (let i = period; i < values.length; i += 1) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

function macd(closes) {
  if (closes.length < 35) return { macdLine: null, signalLine: null, histogram: null };
  const ema12 = emaSeries(closes, 12);
  const ema26 = emaSeries(closes, 26);
  const macdLineSeries = closes.map((_, i) => (ema12[i] !== null && ema26[i] !== null ? ema12[i] - ema26[i] : null));
  const validMacd = macdLineSeries.filter((v) => v !== null);
  const signalSeries = emaSeries(validMacd, 9).filter((v) => v !== null);
  const latestMacd = validMacd[validMacd.length - 1] ?? null;
  const latestSignal = signalSeries[signalSeries.length - 1] ?? null;
  return {
    macdLine: latestMacd,
    signalLine: latestSignal,
    histogram: latestMacd !== null && latestSignal !== null ? latestMacd - latestSignal : null
  };
}

function rsi(closes, period = 14) {
  if (closes.length <= period) return null;
  let gains = 0;
  let losses = 0;
  for (let i = closes.length - period; i < closes.length; i += 1) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff;
    else losses += Math.abs(diff);
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function atr(candles, period = 14) {
  if (candles.length <= period) return null;
  const trs = [];
  for (let i = candles.length - period; i < candles.length; i += 1) {
    const current = candles[i];
    const prev = candles[i - 1];
    trs.push(Math.max(current.high - current.low, Math.abs(current.high - prev.close), Math.abs(current.low - prev.close)));
  }
  return average(trs);
}

function rollingLow(candles, period) {
  return Math.min(...candles.slice(-period).map((c) => c.low));
}

function rollingHigh(candles, period) {
  return Math.max(...candles.slice(-period).map((c) => c.high));
}

function scoreTechnical(price, indicators, latestVolume) {
  let score = 50;
  const reasons = [];
  const { sma20, sma50, sma200, rsi14, macd: macdObj, avgVolume20 } = indicators;

  if (sma20 !== null) adjust(price > sma20, 8, -8, `Price is ${price > sma20 ? 'above' : 'below'} the 20-day average.`);
  if (sma50 !== null) adjust(price > sma50, 12, -12, `Price is ${price > sma50 ? 'above' : 'below'} the 50-day average.`);
  if (sma200 !== null) adjust(price > sma200, 15, -15, `Price is ${price > sma200 ? 'above' : 'below'} the 200-day average.`);
  if (sma50 !== null && sma200 !== null) adjust(sma50 > sma200, 10, -10, `50-day average is ${sma50 > sma200 ? 'above' : 'below'} the 200-day average.`);

  if (rsi14 !== null) {
    if (rsi14 >= 45 && rsi14 <= 65) {
      score += 8;
      reasons.push('RSI is in a healthy momentum zone, not stretched.');
    } else if (rsi14 < 30) {
      score += 4;
      reasons.push('RSI is oversold; bounce potential exists but needs confirmation.');
    } else if (rsi14 > 72) {
      score -= 12;
      reasons.push('RSI is very high; fresh entries have pullback risk.');
    } else {
      reasons.push('RSI is neutral/mixed.');
    }
  }

  if (macdObj?.macdLine !== null && macdObj?.signalLine !== null) {
    adjust(macdObj.macdLine > macdObj.signalLine, 10, -10, `MACD is ${macdObj.macdLine > macdObj.signalLine ? 'bullish' : 'bearish'} versus signal line.`);
  }

  if (avgVolume20 && latestVolume && latestVolume > avgVolume20 * 1.25 && price > (sma20 || price)) {
    score += 5;
    reasons.push('Volume is above average while price is firm.');
  }

  return { score: clamp(Math.round(score), 0, 100), reasons };

  function adjust(condition, positive, negative, reason) {
    score += condition ? positive : negative;
    reasons.push(reason);
  }
}

function scoreFundamentals(summary) {
  const sd = summary?.summaryDetail || {};
  const ks = summary?.defaultKeyStatistics || {};
  const fd = summary?.financialData || {};
  const metrics = {
    trailingPE: pickNumber(sd.trailingPE, ks.trailingPE),
    forwardPE: pickNumber(sd.forwardPE, ks.forwardPE),
    priceToBook: pickNumber(ks.priceToBook),
    debtToEquity: pickNumber(fd.debtToEquity),
    profitMargins: pickNumber(fd.profitMargins),
    returnOnEquity: pickNumber(fd.returnOnEquity),
    revenueGrowth: pickNumber(fd.revenueGrowth),
    earningsGrowth: pickNumber(fd.earningsGrowth),
    currentRatio: pickNumber(fd.currentRatio)
  };

  let score = 50;
  const reasons = [];
  let used = 0;

  if (metrics.trailingPE !== null) {
    used += 1;
    if (metrics.trailingPE > 0 && metrics.trailingPE <= 25) {
      score += 12;
      reasons.push('P/E looks reasonable versus a broad quality-growth threshold.');
    } else if (metrics.trailingPE > 25 && metrics.trailingPE <= 45) {
      score += 3;
      reasons.push('P/E is acceptable but not cheap.');
    } else if (metrics.trailingPE > 60) {
      score -= 14;
      reasons.push('P/E looks expensive; valuation risk is elevated.');
    }
  }

  if (metrics.profitMargins !== null) {
    used += 1;
    if (metrics.profitMargins > 0.15) {
      score += 10;
      reasons.push('Profit margin is strong.');
    } else if (metrics.profitMargins < 0) {
      score -= 14;
      reasons.push('Profit margin is negative.');
    } else if (metrics.profitMargins < 0.05) {
      score -= 5;
      reasons.push('Profit margin is thin.');
    }
  }

  if (metrics.returnOnEquity !== null) {
    used += 1;
    if (metrics.returnOnEquity > 0.15) {
      score += 10;
      reasons.push('Return on equity is strong.');
    } else if (metrics.returnOnEquity < 0.05) {
      score -= 6;
      reasons.push('Return on equity is weak.');
    }
  }

  if (metrics.revenueGrowth !== null) {
    used += 1;
    if (metrics.revenueGrowth > 0.08) {
      score += 10;
      reasons.push('Revenue growth is positive and healthy.');
    } else if (metrics.revenueGrowth < 0) {
      score -= 10;
      reasons.push('Revenue growth is negative.');
    }
  }

  if (metrics.earningsGrowth !== null) {
    used += 1;
    if (metrics.earningsGrowth > 0.08) {
      score += 8;
      reasons.push('Earnings growth is positive.');
    } else if (metrics.earningsGrowth < 0) {
      score -= 8;
      reasons.push('Earnings growth is negative.');
    }
  }

  if (metrics.debtToEquity !== null) {
    used += 1;
    if (metrics.debtToEquity < 80) {
      score += 8;
      reasons.push('Debt-to-equity is manageable.');
    } else if (metrics.debtToEquity > 200) {
      score -= 10;
      reasons.push('Debt-to-equity is high.');
    }
  }

  if (metrics.currentRatio !== null) {
    used += 1;
    if (metrics.currentRatio > 1.2) {
      score += 4;
      reasons.push('Current ratio suggests adequate short-term liquidity.');
    } else if (metrics.currentRatio < 0.9) {
      score -= 4;
      reasons.push('Current ratio is below 1.');
    }
  }

  if (used <= 2) {
    reasons.push('Limited fundamental data was available, so the fundamental score stays mostly neutral.');
  }

  return { score: clamp(Math.round(score), 0, 100), completeness: used, metrics, reasons };
}

function classifyRecommendation(overallScore, technicalScore, price, sma200) {
  if (overallScore >= 70 && technicalScore >= 62) return 'BUY';
  if (overallScore <= 44) return 'SELL';
  if (sma200 && price < sma200 && technicalScore <= 40) return 'SELL';
  return 'HOLD';
}

function buildTradePlan(recommendation, price, indicators) {
  const atrValue = indicators.atr14 || price * 0.03;
  const support = indicators.support60 || price - 2 * atrValue;
  const resistance = indicators.resistance60 || price + 2 * atrValue;
  const trendAnchor = indicators.sma50 || indicators.sma20 || price;
  let entryLow = Math.max(support, trendAnchor - atrValue * 0.65);
  let entryHigh = Math.min(price, trendAnchor + atrValue * 0.25);
  if (recommendation === 'SELL') {
    entryLow = null;
    entryHigh = null;
  }
  const breakoutBuyAbove = resistance + atrValue * 0.15;
  const stopLoss = recommendation === 'SELL'
    ? Math.min(support - atrValue * 0.5, price - atrValue * 1.2)
    : Math.min(support - atrValue * 0.6, price - atrValue * 1.4);
  const riskPerShare = Math.max(price - stopLoss, atrValue);
  const target1 = Math.max(resistance, price + riskPerShare * 1.5);
  const target2 = price + riskPerShare * 2.4;

  return roundObject({
    entryLow,
    entryHigh,
    breakoutBuyAbove,
    stopLoss,
    target1,
    target2,
    support,
    resistance,
    invalidation: stopLoss,
    note: recommendation === 'BUY'
      ? 'Prefer entry near the entry zone. A breakout above resistance can be a momentum entry, but use smaller size.'
      : recommendation === 'HOLD'
        ? 'Existing holders can trail risk near support/stop. Fresh entries need better confirmation.'
        : 'Avoid fresh entries until price reclaims key moving averages and closes above resistance.'
  });
}

function buildPortfolioView(holding, price) {
  const quantity = Number(holding.quantity || 0);
  const avgPrice = Number(holding.avgPrice || 0);
  const invested = quantity && avgPrice ? quantity * avgPrice : null;
  const currentValue = quantity ? quantity * price : null;
  const pnl = invested !== null && currentValue !== null ? currentValue - invested : null;
  const pnlPercent = invested ? (pnl / invested) * 100 : null;
  return roundObject({ quantity, avgPrice, invested, currentValue, pnl, pnlPercent });
}

function buildAiNarrative({ symbol, recommendation, overallScore, technical, fundamentals, tradePlan, risk, price, indicators }) {
  const techScore = technical.score;
  const fundScore = fundamentals.score;
  const rsi = indicators.rsi14;
  const above200 = indicators.sma200 ? price > indicators.sma200 : null;
  const bullishTrend = above200 && indicators.sma50 && price > indicators.sma50;
  const stretched = rsi !== null && rsi > 70;
  const weakMomentum = techScore < 45;
  let headline;
  let summary;
  let bestFor;
  let entryStyle;
  let mainRisk;

  if (recommendation === 'BUY') {
    headline = `${symbol} has a constructive setup, but entry discipline matters.`;
    summary = bullishTrend
      ? `The stock is trading above important moving averages, technical score is strong at ${techScore}/100, and the overall signal score is ${overallScore}/100. The better approach is to accumulate near the entry zone rather than chase a sharp move.`
      : `The overall signal is positive at ${overallScore}/100, but the trend is not perfectly clean. Treat this as a selective buy setup and wait for confirmation near the breakout level.`;
    bestFor = 'Accumulation / swing trade';
    entryStyle = stretched ? 'Wait for pullback' : 'Entry zone first';
    mainRisk = risk === 'High' ? 'High volatility' : 'False breakout';
  } else if (recommendation === 'SELL') {
    headline = `${symbol} currently has a weak risk-reward setup.`;
    summary = `The signal score is ${overallScore}/100 with technical score at ${techScore}/100. Until the price reclaims key moving averages and resistance, fresh buying is not attractive. Existing holders should review position size and invalidation levels.`;
    bestFor = 'Avoid / review holding';
    entryStyle = 'Wait for reversal';
    mainRisk = 'Trend continuation lower';
  } else {
    headline = `${symbol} is not a clean buy or sell yet.`;
    summary = `The model is neutral with an overall score of ${overallScore}/100. The better action is to monitor whether price holds support or breaks above resistance before adding fresh capital.`;
    bestFor = 'Watchlist / hold';
    entryStyle = 'Wait for confirmation';
    mainRisk = weakMomentum ? 'Momentum weakness' : 'Range-bound movement';
  }

  if (fundScore < 45) mainRisk = 'Fundamental weakness';

  return { headline, summary, bestFor, entryStyle, mainRisk };
}

function buildPortfolioAnalytics(items) {
  if (!items.length) {
    return {
      healthScore: 0,
      riskLevel: 'Unknown',
      topHoldingWeight: 0,
      summary: ['No valid holdings could be analyzed.'],
      nextActions: ['Upload a CSV with columns: symbol, quantity, avgPrice.']
    };
  }

  const valueItems = items.map((item) => ({
    symbol: item.symbol,
    recommendation: item.recommendation,
    score: item.overallScore || 0,
    risk: item.risk || 'Unknown',
    value: Number(item.portfolio?.currentValue || 0),
    pnl: Number(item.portfolio?.pnl || 0)
  }));

  const totalValue = valueItems.reduce((sum, item) => sum + item.value, 0);
  const totalPnl = valueItems.reduce((sum, item) => sum + item.pnl, 0);
  const weightedScore = totalValue > 0
    ? valueItems.reduce((sum, item) => sum + item.score * (item.value / totalValue), 0)
    : average(valueItems.map((item) => item.score));
  const buyCount = valueItems.filter((item) => item.recommendation === 'BUY').length;
  const holdCount = valueItems.filter((item) => item.recommendation === 'HOLD').length;
  const sellCount = valueItems.filter((item) => item.recommendation === 'SELL').length;
  const top = valueItems.slice().sort((a, b) => b.value - a.value)[0];
  const topHoldingWeight = totalValue > 0 ? (top.value / totalValue) * 100 : 0;
  const highRiskCount = valueItems.filter((item) => item.risk === 'High').length;
  const negativeCount = valueItems.filter((item) => item.pnl < 0).length;
  let healthScore = clamp(Math.round(weightedScore), 0, 100);
  if (topHoldingWeight > 40) healthScore -= 8;
  if (sellCount > buyCount) healthScore -= 8;
  if (highRiskCount >= Math.ceil(items.length / 3)) healthScore -= 6;
  healthScore = clamp(healthScore, 0, 100);
  const riskLevel = healthScore >= 72 && topHoldingWeight < 35 ? 'Low' : healthScore >= 55 ? 'Medium' : 'High';
  const best = valueItems.slice().sort((a, b) => b.score - a.score).slice(0, 2).map((i) => i.symbol).join(', ');
  const weakest = valueItems.slice().sort((a, b) => a.score - b.score).slice(0, 2).map((i) => i.symbol).join(', ');
  const summary = [
    `Portfolio signal mix is ${buyCount} Buy, ${holdCount} Hold, and ${sellCount} Sell across ${items.length} stocks.`,
    totalValue > 0
      ? `Total analyzed portfolio value is ${Math.round(totalValue).toLocaleString('en-IN')} with total P&L of ${Math.round(totalPnl).toLocaleString('en-IN')}.`
      : 'Portfolio value could not be calculated because quantity/average price is missing for some holdings.',
    topHoldingWeight > 40
      ? `Concentration risk is high: ${top.symbol} is approximately ${round(topHoldingWeight)}% of the portfolio.`
      : `Largest holding weight is approximately ${round(topHoldingWeight)}%, which is manageable for a first-level check.`,
    best ? `Strongest model-ranked names: ${best}.` : 'No clear strong names detected.',
    weakest ? `Weakest model-ranked names to review first: ${weakest}.` : 'No weak names detected.'
  ];
  const nextActions = [
    sellCount > 0 ? 'Review Sell-rated positions first; check whether thesis has broken or only price momentum is weak.' : 'No immediate Sell-rated names from the model.',
    topHoldingWeight > 35 ? 'Reduce new buying in the largest holding until portfolio concentration becomes healthier.' : 'Concentration looks acceptable; focus on improving entry levels.',
    negativeCount > 0 ? 'For loss-making positions, compare current price with stop-loss/invalidation before averaging.' : 'For profitable positions, consider trailing stop-loss near support.',
    'Use the chart to confirm trend, support hold, and volume before acting.'
  ];
  return roundObject({ healthScore, riskLevel, topHoldingWeight, summary, nextActions });
}

function riskLevel(price, atrValue) {
  if (!price || !atrValue) return 'Unknown';
  const vol = atrValue / price;
  if (vol > 0.05) return 'High';
  if (vol > 0.025) return 'Medium';
  return 'Low';
}

function confidenceLabel(historyLength, fundamentalCompleteness) {
  if (historyLength >= 200 && fundamentalCompleteness >= 5) return 'High';
  if (historyLength >= 120 && fundamentalCompleteness >= 3) return 'Medium';
  return 'Low';
}

function round(value, digits = 2) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return null;
  return Number(Number(value).toFixed(digits));
}

function roundObject(obj) {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj !== 'object') return round(obj);
  if (Array.isArray(obj)) return obj.map(roundObject);
  const output = {};
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === 'number') output[key] = round(value);
    else if (value && typeof value === 'object') output[key] = roundObject(value);
    else output[key] = value;
  }
  return output;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
app.listen(PORT, () => {
  console.log(`Double Digit running on http://localhost:${PORT}`);
});
