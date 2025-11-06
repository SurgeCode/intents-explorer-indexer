import fs from 'fs';
import path from 'path';

interface Transaction {
  originAsset: string;
  destinationAsset?: string;
  referral?: string;
  amountIn: string;
  amountOut?: string;
  appFees: Array<{ fee: number; recipient: string }>;
  status: string;
  createdAt: string;
  createdAtTimestamp: number;
  depositAddress: string;
  withdrawAddress?: string;
}

interface PageResponse {
  data: Transaction[];
  totalPages: number;
  page: number;
  perPage: number;
  total: number;
  nextPage: number | null;
  prevPage: number | null;
}

interface State {
  currentPage: number;
  endTimestampUnix: number | null;
  lastProcessedDepositAddress: string | null;
  totalProcessed: number;
  lastUpdated: string;
}

interface FeeEntry {
  timestamp: string;
  referral: string;
  inflowAsset: string;
  inflowAmount: number;
  outflowAsset: string;
  outflowAmount: number;
  fee: number;
  depositAddress: string;
  withdrawAddress: string;
}

const API_KEY = 'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCIsImtpZCI6IjIwMjUtMDQtMjMtdjEifQ.eyJ2IjoxLCJrZXlfdHlwZSI6ImV4cGxvcmVyIiwicGFydG5lcl9pZCI6InN1cmdlIiwiaWF0IjoxNzUyNTk2MjQzLCJleHAiOjE3ODQxMzIyNDN9.R1HnN1fOsQDkKt-PuRb0Rr2_3him0sSY7RMtRJYymDYj3XOQ04AQYKzVXDEczJ27dUodSIQ4yNQ4dHffME_jyAdTInhCaTtl_54VcNkurVY5KbQseOHblHXyekeYc7lzHi8FAJr3gtEV5GDW4zQ4DesJiIvbqWtTC6cfAWW0DuC80vTsWSOA25P5xBVTj65oTWF0o_Yo3dfRy4_PQtWLE-LFH7Jq1hAUTd0-423wQkKo5CEjdoHe55bfxvHc7FLkc19vBhk_RkwXMZpOjlMm7OMzZt9znpUicU8CILb0s7d675RCs_MIFzbNQhpP8sdqVbauRdgIJGJNLo2TKoI8fg';
const BASE_URL = 'https://explorer.near-intents.org/api/v0/transactions-pages';
const STATE_FILE = path.join(__dirname, 'indexer-state.json');
const CSV_FILE = path.join(__dirname, 'referral-fees.csv');
const DELAY_MS = 1000;
const PER_PAGE = 1000;

function calculateFee(amountIn: string, feeBps: number): number {
  const amount = parseFloat(amountIn);
  return amount * (feeBps / 10_000);
}

function loadState(): State {
  if (fs.existsSync(STATE_FILE)) {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
  }
  return { 
    currentPage: 1, 
    endTimestampUnix: null, 
    lastProcessedDepositAddress: null,
    totalProcessed: 0,
    lastUpdated: new Date().toISOString() 
  };
}

function saveState(state: State): void {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}


function writeToCsv(feeEntries: FeeEntry[]): void {
  const existing = fs.existsSync(CSV_FILE) 
    ? fs.readFileSync(CSV_FILE, 'utf-8').split('\n').slice(1).filter(l => l.trim())
    : [];
  
  const newLines = feeEntries.map(e => 
    `${e.timestamp},${e.referral},${e.inflowAsset},${e.inflowAmount},${e.outflowAsset},${e.outflowAmount},${e.fee},${e.depositAddress},${e.withdrawAddress}`
  );
  
  const lines = ['Timestamp,Referral,InflowAsset,InflowAmount,OutflowAsset,OutflowAmount,Fee,DepositAddress,WithdrawAddress', ...existing, ...newLines];
  fs.writeFileSync(CSV_FILE, lines.join('\n'));
}

async function fetchPage(page: number, endTimestampUnix: number | null): Promise<PageResponse> {
  const params = new URLSearchParams({
    page: page.toString(),
    perPage: PER_PAGE.toString(),
  });
  
  if (endTimestampUnix) {
    params.append('endTimestampUnix', endTimestampUnix.toString());
  }
  
  const url = `${BASE_URL}?${params.toString()}`;
  
  const response = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
    },
  });
  
  if (!response.ok) {
    throw new Error(`Failed to fetch page ${page}: ${response.status}`);
  }
  
  return response.json() as Promise<PageResponse>;
}

function processTxns(txns: Transaction[]): FeeEntry[] {
  const entries: FeeEntry[] = [];
  
  for (const tx of txns) {
    if (!tx.referral || !tx.appFees || tx.appFees.length === 0) continue;
    
    const inflowAmount = parseFloat(tx.amountIn);
    const outflowAmount = tx.amountOut ? parseFloat(tx.amountOut) : 0;
    
    for (const appFee of tx.appFees) {
      const feeAmount = calculateFee(tx.amountIn, appFee.fee);
      entries.push({
        timestamp: tx.createdAt,
        referral: tx.referral,
        inflowAsset: tx.originAsset,
        inflowAmount: inflowAmount,
        outflowAsset: tx.destinationAsset || tx.originAsset,
        outflowAmount: outflowAmount,
        fee: feeAmount,
        depositAddress: tx.depositAddress,
        withdrawAddress: tx.withdrawAddress || ''
      });
    }
  }
  
  return entries;
}

async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  console.log('Starting fee indexer...');
  
  const state = loadState();
  
  if (state.endTimestampUnix) {
    console.log(`Resuming from page ${state.currentPage}, filtering transactions before ${new Date(state.endTimestampUnix * 1000).toISOString()}`);
    console.log(`Already processed: ${state.totalProcessed} transactions`);
  } else {
    console.log('Starting fresh indexing...');
  }
  
  try {
    let currentPage = state.currentPage;
    let processedInSession = 0;
    
    while (true) {
      console.log(`Fetching page ${currentPage}...`);
      
      const pageData = await fetchPage(currentPage, state.endTimestampUnix);
      
      if (pageData.data.length === 0) {
        console.log('No more transactions to process!');
        break;
      }
      
      console.log(`Processing ${pageData.data.length} transactions (Page ${currentPage}/${pageData.totalPages})`);
      
      if (currentPage === 1 && !state.endTimestampUnix && pageData.data.length > 0) {
        const oldestTx = pageData.data[pageData.data.length - 1];
        state.endTimestampUnix = oldestTx.createdAtTimestamp;
        state.lastProcessedDepositAddress = oldestTx.depositAddress;
        console.log(`Locked snapshot at ${new Date(state.endTimestampUnix * 1000).toISOString()}`);
      }
      
      const feeEntries = processTxns(pageData.data);
      processedInSession += pageData.data.length;
      
      writeToCsv(feeEntries);
      
      state.currentPage = currentPage + 1;
      state.totalProcessed += pageData.data.length;
      state.lastUpdated = new Date().toISOString();
      saveState(state);
      
      console.log(`Progress: Page ${currentPage}/${pageData.totalPages} | Session: ${processedInSession} | Total: ${state.totalProcessed}`);
      
      if (!pageData.nextPage) {
        console.log('All pages processed!');
        break;
      }
      
      currentPage = pageData.nextPage;
      
      await sleep(DELAY_MS);
    }
    
    console.log(`\nIndexing complete! Results written to ${CSV_FILE}`);
    console.log(`Total transactions processed: ${state.totalProcessed}`);
    
  } catch (error) {
    console.error('Error during indexing:', error);
    process.exit(1);
  }
}

main();

