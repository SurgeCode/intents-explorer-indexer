import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { put } from '@vercel/blob';
import dotenv from 'dotenv';
import { parse } from 'csv-parse/sync';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

interface TokenData {
  assetId: string;
  symbol: string;
  blockchain: string;
}

interface RouteData {
  fromAsset: string;
  toAsset: string;
  volumeUSD: number;
  count: number;
}

interface CSVRecord {
  Timestamp: string;
  Provider: string;
  InflowAsset: string;
  InflowAmount: string;
  InflowUSD: string;
  OutflowAsset: string;
  OutflowAmount: string;
  OutflowUSD: string;
  AppFees: string;
  DepositAddress: string;
  Recipient: string;
  OriginTxHash: string;
  DestinationTxHash: string;
  Status: string;
}

interface ProcessedData {
  leaderboard: Array<{ referral: string; totalFeesUSD: number }>;
  chartData: Array<{ date: string; cumulativeFees: number; dailyFees: number }>;
  assetFlows: Array<{
    symbol: string;
    totalInflowUSD: number;
    totalOutflowUSD: number;
    netFlowUSD: number;
    inflowCount: number;
    outflowCount: number;
  }>;
  chainFlows: Array<{
    chain: string;
    totalInflowUSD: number;
    totalOutflowUSD: number;
    netFlowUSD: number;
    inflowCount: number;
    outflowCount: number;
  }>;
  providerFlows: Array<{
    provider: string;
    totalInflowUSD: number;
    totalOutflowUSD: number;
    netFlowUSD: number;
    totalFeesUSD: number;
    averageFeeBps: number;
    transactionCount: number;
  }>;
  providerAssetFlows: Array<{
    provider: string;
    symbol: string;
    totalInflowUSD: number;
    totalOutflowUSD: number;
    netFlowUSD: number;
    inflowCount: number;
    outflowCount: number;
  }>;
  topRoutes: RouteData[];
  totalInflowUSD: number;
  totalOutflowUSD: number;
  totalFees: number;
  totalReferrals: number;
  lastUpdated: string;
}

const CONFIG = {
  BLOB_TOKEN: process.env.BLOB_READ_WRITE_TOKEN,
  TOKEN_API_URL: 'https://1click.chaindefuser.com/v0/tokens',
  CSV_FILE: path.join(__dirname, 'referral-fees.csv'),
  TOP_ROUTES_LIMIT: 50,
  BPS_DIVISOR: 10_000,
};

async function fetchTokenMap(): Promise<Map<string, { symbol: string; chain: string }>> {
  const response = await fetch(CONFIG.TOKEN_API_URL);
  const tokens = await response.json() as TokenData[];
  
  const map = new Map<string, { symbol: string; chain: string }>();
  tokens.forEach(t => {
    map.set(t.assetId, { symbol: t.symbol, chain: t.blockchain || 'Unknown' });
  });
  
  console.log(`Loaded ${tokens.length} tokens`);
  return map;
}

async function processCSV(): Promise<ProcessedData> {
  const csvContent = fs.readFileSync(CONFIG.CSV_FILE, 'utf-8');
  const records = parse(csvContent, {
    columns: true,
    skip_empty_lines: true,
    escape: '"',
  }) as CSVRecord[];
  
  console.log(`Processing ${records.length} transactions...`);
  
  const tokenMap = await fetchTokenMap();
  
  const referralTotals = new Map<string, number>();
  const dailyTotals = new Map<string, number>();
  const assetFlows = new Map<string, { inflowUSD: number; outflowUSD: number; inflowCount: number; outflowCount: number }>();
  const chainFlows = new Map<string, { inflowUSD: number; outflowUSD: number; inflowCount: number; outflowCount: number }>();
  const providerFlows = new Map<string, { inflowUSD: number; outflowUSD: number; feesUSD: number; totalBps: number; txCount: number }>();
  const providerAssetFlows = new Map<string, { inflowUSD: number; outflowUSD: number; inflowCount: number; outflowCount: number }>();
  const routes = new Map<string, { volumeUSD: number; count: number }>();
  const processedDepositAddresses = new Set<string>();
  
  let totalInflowUSD = 0;
  let totalOutflowUSD = 0;
  
  for (const record of records) {
    const { Timestamp, Provider, InflowAsset, OutflowAsset, InflowUSD, OutflowUSD, AppFees, DepositAddress } = record;
    
    if (!Timestamp || !Provider) continue;
    
    const inflowUSD = parseFloat(InflowUSD || '0');
    const outflowUSD = parseFloat(OutflowUSD || '0');
    const appFees: Array<{ fee: number; recipient: string }> = JSON.parse(AppFees || '[]');
    
    const inflowToken = tokenMap.get(InflowAsset);
    const outflowToken = tokenMap.get(OutflowAsset);
    
    const inflowSymbol = inflowToken?.symbol || InflowAsset;
    const outflowSymbol = outflowToken?.symbol || OutflowAsset;
    
    const sourceChain = inflowToken?.chain || 'Unknown';
    const destChain = outflowToken?.chain || 'Unknown';
    
    const isNewTransaction = !processedDepositAddresses.has(DepositAddress);
    
    if (isNewTransaction) {
      processedDepositAddresses.add(DepositAddress);
      
      totalInflowUSD += inflowUSD;
      totalOutflowUSD += outflowUSD;
      
      updateMap(assetFlows, inflowSymbol, { inflowUSD, inflowCount: 1 });
      updateMap(providerAssetFlows, `${Provider}:${inflowSymbol}`, { inflowUSD, inflowCount: 1 });
      
      if (outflowUSD > 0) {
        updateMap(assetFlows, outflowSymbol, { outflowUSD, outflowCount: 1 });
        updateMap(providerAssetFlows, `${Provider}:${outflowSymbol}`, { outflowUSD, outflowCount: 1 });
        updateMap(routes, `${inflowSymbol} → ${outflowSymbol}`, { volumeUSD: inflowUSD, count: 1 });
      }
      
      updateMap(chainFlows, sourceChain, { inflowUSD, inflowCount: 1 });
      updateMap(chainFlows, destChain, { outflowUSD, outflowCount: 1 });
    }
    
    const date = Timestamp.split('T')[0];
    
    for (const { fee } of appFees) {
      const feeUSD = (inflowUSD * fee) / CONFIG.BPS_DIVISOR;
      
      if (isNewTransaction) {
        updateMap(providerFlows, Provider, { inflowUSD, outflowUSD, feesUSD: feeUSD, totalBps: fee, txCount: 1 });
      } else {
        updateMap(providerFlows, Provider, { inflowUSD: 0, outflowUSD: 0, feesUSD: feeUSD, totalBps: fee, txCount: 0 });
      }
      
      referralTotals.set(Provider, (referralTotals.get(Provider) || 0) + feeUSD);
      dailyTotals.set(date, (dailyTotals.get(date) || 0) + feeUSD);
    }
  }
  
  return {
    leaderboard: Array.from(referralTotals.entries())
      .map(([referral, totalFeesUSD]) => ({ referral, totalFeesUSD }))
      .sort((a, b) => b.totalFeesUSD - a.totalFeesUSD),
    
    chartData: buildChartData(dailyTotals),
    
    assetFlows: Array.from(assetFlows.entries())
      .map(([symbol, flow]) => ({
        symbol,
        totalInflowUSD: flow.inflowUSD,
        totalOutflowUSD: flow.outflowUSD,
        netFlowUSD: flow.inflowUSD - flow.outflowUSD,
        inflowCount: flow.inflowCount,
        outflowCount: flow.outflowCount,
      }))
      .sort((a, b) => Math.abs(b.netFlowUSD) - Math.abs(a.netFlowUSD)),
    
    chainFlows: Array.from(chainFlows.entries())
      .map(([chain, flow]) => ({
        chain,
        totalInflowUSD: flow.inflowUSD,
        totalOutflowUSD: flow.outflowUSD,
        netFlowUSD: flow.inflowUSD - flow.outflowUSD,
        inflowCount: flow.inflowCount,
        outflowCount: flow.outflowCount,
      }))
      .sort((a, b) => Math.abs(b.netFlowUSD) - Math.abs(a.netFlowUSD)),
    
    providerFlows: Array.from(providerFlows.entries())
      .map(([provider, flow]) => ({
        provider,
        totalInflowUSD: flow.inflowUSD,
        totalOutflowUSD: flow.outflowUSD,
        netFlowUSD: flow.inflowUSD - flow.outflowUSD,
        totalFeesUSD: flow.feesUSD,
        averageFeeBps: flow.txCount > 0 ? flow.totalBps / flow.txCount : 0,
        transactionCount: flow.txCount,
      }))
      .sort((a, b) => b.totalFeesUSD - a.totalFeesUSD),
    
    providerAssetFlows: Array.from(providerAssetFlows.entries())
      .map(([key, flow]) => {
        const [provider, symbol] = key.split(':');
        return {
          provider,
          symbol,
          totalInflowUSD: flow.inflowUSD,
          totalOutflowUSD: flow.outflowUSD,
          netFlowUSD: flow.inflowUSD - flow.outflowUSD,
          inflowCount: flow.inflowCount,
          outflowCount: flow.outflowCount,
        };
      })
      .sort((a, b) => Math.abs(b.netFlowUSD) - Math.abs(a.netFlowUSD)),
    
    topRoutes: Array.from(routes.entries())
      .map(([route, data]) => {
        const [fromAsset, toAsset] = route.split(' → ');
        return { fromAsset, toAsset, volumeUSD: data.volumeUSD, count: data.count };
      })
      .sort((a, b) => b.volumeUSD - a.volumeUSD)
      .slice(0, CONFIG.TOP_ROUTES_LIMIT),
    
    totalInflowUSD,
    totalOutflowUSD,
    totalFees: Array.from(referralTotals.values()).reduce((sum, val) => sum + val, 0),
    totalReferrals: referralTotals.size,
    lastUpdated: new Date().toISOString(),
  };
}

function updateMap<T extends Record<string, number>>(
  map: Map<string, T>,
  key: string,
  updates: Partial<T>
): void {
  const existing = map.get(key) || {} as T;
  map.set(key, {
    ...existing,
    ...Object.fromEntries(
      Object.entries(updates).map(([k, v]) => [k, (existing[k as keyof T] as number || 0) + (v as number)])
    ),
  } as T);
}

function buildChartData(dailyTotals: Map<string, number>): Array<{ date: string; cumulativeFees: number; dailyFees: number }> {
  const sortedDates = Array.from(dailyTotals.keys()).sort();
  let cumulative = 0;
  
  return sortedDates.map(date => {
    const dailyFees = dailyTotals.get(date) || 0;
    cumulative += dailyFees;
    return { date, cumulativeFees: cumulative, dailyFees };
  });
}

async function uploadToBlob(data: ProcessedData): Promise<string> {
  if (!CONFIG.BLOB_TOKEN) {
    throw new Error('BLOB_READ_WRITE_TOKEN environment variable is required');
  }
  
  const { url } = await put('referral-fees.json', JSON.stringify(data), {
    access: 'public',
    token: CONFIG.BLOB_TOKEN,
    addRandomSuffix: false,
  });
  
  console.log(`Uploaded: ${url}`);
  return url;
}

async function main() {
  console.log('Processing fees...');
  
  const data = await processCSV();
  
  console.log(`\nTotal Fees: $${data.totalFees.toFixed(2)}`);
  console.log(`Total Volume: $${data.totalInflowUSD.toFixed(2)}`);
  console.log(`Providers: ${data.totalReferrals}`);
  
  await uploadToBlob(data);
  
  console.log('Done!');
}

main().catch(error => {
  console.error('Processing failed:', error);
  process.exit(1);
});
