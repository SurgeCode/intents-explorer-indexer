# Fee Indexer

Indexes all transactions from the Near Intents Explorer API and calculates total fees generated per referral per asset.

## Setup

```bash
npm install
```

## Usage

```bash
npm run index
```

## Features

- **Resumable**: Tracks progress in `indexer-state.json` - stop and restart anytime
- **Incremental CSV**: Updates `referral-fees.csv` after each page
- **Rate limited**: 1000ms delay between requests to avoid spamming the server
- **Fee calculation**: Calculates fees based on appFees (basis points) from input amount
- **Timestamp-locked pagination**: Creates a stable snapshot to handle new transactions arriving during indexing

## How It Handles New Transactions

When you start indexing, the script:
1. Fetches the first page
2. Records the oldest transaction timestamp
3. Uses `endTimestampUnix` filter on all subsequent requests

This creates a **stable snapshot** of transactions. Even if 10,000 new transactions arrive while you're indexing, they won't affect your pagination because you're only fetching transactions created *before* your snapshot timestamp.

When you finish and want to index newer transactions, delete `indexer-state.json` to start a fresh run.

## Output

`referral-fees.csv` contains:
```
Referral,Asset,Total Fee
some-referral,nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near,1234.56
some-referral,nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1,7890.12
```

## State Management

`indexer-state.json` tracks:
- Current page number
- Snapshot timestamp (endTimestampUnix)
- Total transactions processed
- Last updated timestamp

Delete this file to restart from scratch with a fresh snapshot.

