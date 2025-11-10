import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

interface Transaction {
  originAsset: string;
  destinationAsset: string;
  referral: string;
  amountIn: string;
  amountInUsd: string;
  amountOut: string;
  amountOutUsd: string;
  recipient: string;
  originChainTxHashes: string[];
  destinationChainTxHashes: string[];
  appFees: Array<{ fee: number; recipient: string }>;
  status: string;
  createdAt: string;
  depositAddress: string;
}

interface PageResponse {
  data: Transaction[];
  totalPages: number;
  nextPage: number | null;
}

const CONFIG = {
  API_KEY: process.env.EXPLORER_API_KEY,
  BASE_URL: 'https://explorer.near-intents.org/api/v0/transactions-pages',
  CSV_FILE: path.join(__dirname, 'referral-fees.csv'),
  DELAY_MS: 2000,
  PER_PAGE: 1000,
  CSV_HEADER: 'Timestamp,Provider,InflowAsset,InflowAmount,InflowUSD,OutflowAsset,OutflowAmount,OutflowUSD,AppFees,DepositAddress,Recipient,OriginTxHash,DestinationTxHash,Status',
  DEPOSIT_ADDRESS_INDEX: 9,
};

function getExistingDepositAddresses(): Set<string> {
  if (!fs.existsSync(CONFIG.CSV_FILE)) return new Set();
  
  const lines = fs.readFileSync(CONFIG.CSV_FILE, 'utf-8')
    .split('\n')
    .slice(1)
    .filter(l => l.trim());
  
  return new Set(lines.map(line => line.split(',')[CONFIG.DEPOSIT_ADDRESS_INDEX]));
}

function appendToCsv(csvLines: string[]): void {
  if (!fs.existsSync(CONFIG.CSV_FILE)) {
    const lines = [CONFIG.CSV_HEADER, ...csvLines];
    fs.writeFileSync(CONFIG.CSV_FILE, lines.join('\n'));
    return;
  }
  
  const existing = fs.readFileSync(CONFIG.CSV_FILE, 'utf-8').split('\n');
  const allLines = [...existing.filter(l => l.trim()), ...csvLines];
  fs.writeFileSync(CONFIG.CSV_FILE, allLines.join('\n'));
}

async function fetchPage(page: number): Promise<PageResponse> {
  if (!CONFIG.API_KEY) {
    throw new Error('EXPLORER_API_KEY environment variable is required');
  }
  
  const params = new URLSearchParams({
    page: page.toString(),
    perPage: CONFIG.PER_PAGE.toString(),
  });
  
  const response = await fetch(`${CONFIG.BASE_URL}?${params}`, {
    headers: {
      'Authorization': `Bearer ${CONFIG.API_KEY}`,
      'Content-Type': 'application/json',
    },
  });
  
  if (!response.ok) {
    throw new Error(`API request failed: ${response.status}`);
  }
  
  return response.json() as Promise<PageResponse>;
}

function transactionToCsvLine(tx: Transaction): string {
  const fields = [
    tx.createdAt,
    tx.referral || 'unknown',
    tx.originAsset,
    tx.amountIn,
    tx.amountInUsd,
    tx.destinationAsset,
    tx.amountOut,
    tx.amountOutUsd,
    JSON.stringify(tx.appFees || []),
    tx.depositAddress,
    tx.recipient,
    tx.originChainTxHashes[0] || '',
    tx.destinationChainTxHashes[0] || '',
    tx.status,
  ];
  
  return fields.map((f, i) => i === 8 ? `"${f.replace(/"/g, '""')}"` : f).join(',');
}

async function indexTransactions(): Promise<void> {
  const existingAddresses = getExistingDepositAddresses();
  
  console.log(`Starting indexing (${existingAddresses.size} existing transactions)`);
  
  let page = 1;
  let totalNew = 0;
  let consecutiveEmptyPages = 0;
  
  while (true) {
    console.log(`Fetching page ${page}...`);
    
    const { data, totalPages, nextPage } = await fetchPage(page);
    
    if (data.length === 0) break;
    
    const newLines: string[] = [];
    
    for (const tx of data) {
      if (!tx.appFees?.length) continue;
      if (existingAddresses.has(tx.depositAddress)) continue;
      
      existingAddresses.add(tx.depositAddress);
      newLines.push(transactionToCsvLine(tx));
    }
    
    if (newLines.length > 0) {
      appendToCsv(newLines);
      totalNew += newLines.length;
      consecutiveEmptyPages = 0;
    } else {
      consecutiveEmptyPages++;
    }
    
    console.log(`Page ${page}/${totalPages} | New: ${newLines.length} | Total new: ${totalNew}`);
    
    if (consecutiveEmptyPages >= 3) {
      console.log('Found 3 consecutive pages with no new data, stopping');
      break;
    }
    
    if (!nextPage) break;
    
    page = nextPage;
    await new Promise(resolve => setTimeout(resolve, CONFIG.DELAY_MS));
  }
  
  console.log(`\nComplete! Added ${totalNew} new entries to ${CONFIG.CSV_FILE}`);
}

indexTransactions().catch(error => {
  console.error('Indexing failed:', error);
  process.exit(1);
});

