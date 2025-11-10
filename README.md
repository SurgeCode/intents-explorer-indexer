# Fee Indexing System

Indexes and processes transaction data from NEAR Intents 1-Click Explorer API. Outputs daily aggregated metrics to Vercel Blob Storage.

## Setup

```bash
npm install
```

Create `.env`:
```bash
EXPLORER_API_KEY=your_explorer_api_key
BLOB_READ_WRITE_TOKEN=your_vercel_blob_token
```

## Run

```bash
npm run workflow
```

This indexes new transactions and processes them. Uses deduplication to skip existing transactions automatically. Stops after 3 consecutive pages with no new data.

## Output Data

The daily JSON blob contains:

```typescript
{
  leaderboard: [{ referral: string, totalFeesUSD: number }],
  chartData: [{ date: string, cumulativeFees: number, dailyFees: number }],
  assetFlows: [{ symbol: string, totalInflowUSD: number, totalOutflowUSD: number, netFlowUSD: number, ... }],
  chainFlows: [{ chain: string, totalInflowUSD: number, totalOutflowUSD: number, netFlowUSD: number, ... }],
  providerFlows: [{ provider: string, totalInflowUSD: number, totalFeesUSD: number, averageFeeBps: number, ... }],
  topRoutes: [{ fromAsset: string, toAsset: string, volumeUSD: number, count: number }],
  totalInflowUSD: number,
  totalOutflowUSD: number,
  totalFees: number,
  totalReferrals: number,
  lastUpdated: string
}
```

## Frontend Usage

The data is uploaded to a stable URL that never changes:

```typescript
const FEES_URL = 'https://thvomwknsgnklfce.public.blob.vercel-storage.com/referral-fees.json';

const response = await fetch(FEES_URL);
const data = await response.json();
```

## Deployment

Add to crontab for daily runs:

```bash
0 0 * * * cd /path/to/fees && npm run workflow >> /var/log/fees.log 2>&1
```

## Files

- `index.ts` - Fetches transactions (deduplicates automatically)
- `process.ts` - Processes CSV, uploads to blob
- `referral-fees.csv` - Local transaction storage
