# Double Digit

An explainable stock decision-support app for education and research.

## Run locally

```bash
npm install
npm run dev
```

Open `http://localhost:3000`.

## CSV upload format

```csv
symbol,quantity,avgPrice
RELIANCE.NS,8,1400
AAPL,4,175
TSLA,2,210
```

## Notes

- Uses Yahoo Finance data via `yahoo-finance2`.
- Uses local candlestick charts via Lightweight Charts.
- No OpenAI API or paid AI API required.
- Educational decision-support only, not investment advice.
