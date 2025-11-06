import fs from 'fs';
import { put } from '@vercel/blob';

interface TokenData {
  assetId: string;
  decimals: number;
  price: number;
  symbol: string;
}

interface LeaderboardEntry {
  referral: string;
  totalFeesUSD: number;
}

interface ChartDataPoint {
  date: string;
  cumulativeFees: number;
  dailyFees: number;
}

interface AssetFlowData {
  asset: string;
  totalInflowUSD: number;
  totalOutflowUSD: number;
  netFlowUSD: number;
  inflowCount: number;
  outflowCount: number;
}

interface ProcessedData {
  leaderboard: LeaderboardEntry[];
  chartData: ChartDataPoint[];
  assetFlows: AssetFlowData[];
  totalFees: number;
  totalReferrals: number;
  lastUpdated: string;
}

const BLOB_TOKEN = "vercel_blob_rw_tHvoMWkNsgNKLfcE_CkMYAkBDMr6J63qFBnvUOp8TLsxtAu";

async function fetchTokens(): Promise<Map<string, TokenData>> {
  const response = await fetch("https://1click.chaindefuser.com/v0/tokens");
  const tokens = await response.json() as TokenData[];
  
  const tokenMap = new Map<string, TokenData>();
  tokens.forEach((token) => {
    tokenMap.set(token.assetId, token);
  });
  
  console.log(`Loaded ${tokens.length} tokens`);
  return tokenMap;
}

async function processCSV(): Promise<ProcessedData> {
  const csvContent = fs.readFileSync('./referral-fees.csv', 'utf-8');
  const lines = csvContent.trim().split('\n');
  
  console.log(`Processing ${lines.length - 1} CSV lines...`);
  
  const tokenMap = await fetchTokens();
  
  const referralTotals = new Map<string, number>();
  const dailyTotals = new Map<string, number>();
  const assetFlows = new Map<string, { inflowUSD: number; outflowUSD: number; inflowCount: number; outflowCount: number }>();
  
  let processedCount = 0;
  let skippedNoToken = 0;
  let skippedNoPrice = 0;
  let topFees: Array<{asset: string, usd: number, raw: number}> = [];
  
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    
    const [timestamp, referral, inflowAsset, inflowAmountStr, outflowAsset, outflowAmountStr, feeStr] = line.split(',');
    if (!timestamp || !referral || !inflowAsset || !inflowAmountStr) continue;
    
    const inflowAmount = parseFloat(inflowAmountStr);
    const outflowAmount = parseFloat(outflowAmountStr || '0');
    const fee = parseFloat(feeStr || '0');
    
    const inflowToken = tokenMap.get(inflowAsset);
    const outflowToken = outflowAsset ? tokenMap.get(outflowAsset) : null;
    
    if (!inflowToken) {
      skippedNoToken++;
      continue;
    }
    
    if (inflowToken.price <= 0) {
      skippedNoPrice++;
      continue;
    }
    
    const inflowUSD = (inflowAmount / Math.pow(10, inflowToken.decimals)) * inflowToken.price;
    
    const flow = assetFlows.get(inflowAsset) || { inflowUSD: 0, outflowUSD: 0, inflowCount: 0, outflowCount: 0 };
    flow.inflowUSD += inflowUSD;
    flow.inflowCount += 1;
    assetFlows.set(inflowAsset, flow);
    
    if (outflowToken && outflowToken.price > 0 && outflowAmount > 0) {
      const outflowUSD = (outflowAmount / Math.pow(10, outflowToken.decimals)) * outflowToken.price;
      
      const outflow = assetFlows.get(outflowAsset) || { inflowUSD: 0, outflowUSD: 0, inflowCount: 0, outflowCount: 0 };
      outflow.outflowUSD += outflowUSD;
      outflow.outflowCount += 1;
      assetFlows.set(outflowAsset, outflow);
    }
    
    const actualFee = fee / Math.pow(10, inflowToken.decimals) / 10000;
    const usdValue = actualFee * inflowToken.price;
    
    if (topFees.length < 10) {
      topFees.push({asset: inflowToken.symbol, usd: usdValue, raw: fee});
      topFees.sort((a, b) => b.usd - a.usd);
    } else if (usdValue > topFees[9].usd) {
      topFees[9] = {asset: inflowToken.symbol, usd: usdValue, raw: fee};
      topFees.sort((a, b) => b.usd - a.usd);
    }
    
    processedCount++;
    referralTotals.set(referral, (referralTotals.get(referral) || 0) + usdValue);
    
    const date = timestamp.split('T')[0];
    dailyTotals.set(date, (dailyTotals.get(date) || 0) + usdValue);
  }
  
  console.log(`\nProcessing stats:`);
  console.log(`  Processed: ${processedCount}`);
  console.log(`  Skipped (no token): ${skippedNoToken}`);
  console.log(`  Skipped (no price): ${skippedNoPrice}`);
  console.log(`\nTop 10 individual fees:`);
  topFees.forEach((f, i) => {
    console.log(`  ${i+1}. ${f.asset}: $${f.usd.toFixed(2)} (raw: ${f.raw})`);
  });
  
  const leaderboard: LeaderboardEntry[] = Array.from(referralTotals.entries())
    .map(([referral, totalFeesUSD]) => ({ referral, totalFeesUSD }))
    .sort((a, b) => b.totalFeesUSD - a.totalFeesUSD);
  
  const sortedDates = Array.from(dailyTotals.keys()).sort();
  let cumulative = 0;
  const chartData: ChartDataPoint[] = sortedDates.map(date => {
    const dailyFees = dailyTotals.get(date) || 0;
    cumulative += dailyFees;
    return {
      date,
      cumulativeFees: cumulative,
      dailyFees
    };
  });
  
  const assetFlowsArray: AssetFlowData[] = Array.from(assetFlows.entries())
    .map(([asset, flow]) => ({
      asset,
      totalInflowUSD: flow.inflowUSD,
      totalOutflowUSD: flow.outflowUSD,
      netFlowUSD: flow.inflowUSD - flow.outflowUSD,
      inflowCount: flow.inflowCount,
      outflowCount: flow.outflowCount
    }))
    .sort((a, b) => Math.abs(b.netFlowUSD) - Math.abs(a.netFlowUSD));
  
  const totalFees = leaderboard.reduce((sum, entry) => sum + entry.totalFeesUSD, 0);
  
  console.log(`Processed ${referralTotals.size} unique referrals`);
  console.log(`Total fees: $${totalFees.toFixed(2)}`);
  console.log(`Date range: ${sortedDates[0]} to ${sortedDates[sortedDates.length - 1]}`);
  console.log(`\nTop 10 asset flows by net USD:`);
  assetFlowsArray.slice(0, 10).forEach((flow, i) => {
    console.log(`  ${i+1}. ${flow.asset}: Net $${flow.netFlowUSD.toFixed(2)} (In: $${flow.totalInflowUSD.toFixed(2)}, Out: $${flow.totalOutflowUSD.toFixed(2)})`);
  });
  
  return {
    leaderboard,
    chartData,
    assetFlows: assetFlowsArray,
    totalFees,
    totalReferrals: referralTotals.size,
    lastUpdated: new Date().toISOString()
  };
}

async function uploadToBlob(data: ProcessedData): Promise<string> {
  const { url } = await put('referral-fees-processed.json', JSON.stringify(data), {
    access: 'public',
    token: BLOB_TOKEN
  });
  
  console.log(`Uploaded to: ${url}`);
  return url;
}

async function calculateLast2WeeksFees(): Promise<number> {
  const csvContent = fs.readFileSync('./referral-fees.csv', 'utf-8');
  const lines = csvContent.trim().split('\n');
  
  const tokenMap = await fetchTokens();
  
  const twoWeeksAgo = new Date();
  twoWeeksAgo.setDate(twoWeeksAgo.getDate() - 14);
  
  let totalUSD = 0;
  
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    
    const [timestamp, referral, inflowAsset, inflowAmountStr, outflowAsset, outflowAmountStr, feeStr] = line.split(',');
    if (!timestamp || !referral || !inflowAsset || !feeStr) continue;
    
    const entryDate = new Date(timestamp);
    if (entryDate < twoWeeksAgo) continue;
    
    const fee = parseFloat(feeStr);
    const token = tokenMap.get(inflowAsset);
    
    if (token && token.price > 0) {
      const actualAmount = fee / Math.pow(10, token.decimals) / 10000;
      const usdValue = actualAmount * token.price;
      totalUSD += usdValue;
    }
  }
  
  return totalUSD;
}

async function main() {
  console.log('Processing all fees...');
  
  const processedData = await processCSV();
  
  console.log(`\nTotal Fees: $${processedData.totalFees.toFixed(2)}`);
  console.log(`Total Referrals: ${processedData.totalReferrals}`);
  console.log(`\nTop 10 Referrals by fees:`);
  processedData.leaderboard.slice(0, 10).forEach((entry, i) => {
    console.log(`  ${i+1}. ${entry.referral}: $${entry.totalFeesUSD.toFixed(2)}`);
  });
  
  const nearAccountsOnly = processedData.leaderboard.filter(e => e.referral.includes('.near'));
  const nearTotal = nearAccountsOnly.reduce((sum, e) => sum + e.totalFeesUSD, 0);
  console.log(`\n.near accounts only: $${nearTotal.toFixed(2)} (${nearAccountsOnly.length} accounts)`);
  
  const totalDividedBy10 = processedData.totalFees / 10;
  console.log(`\nIf fee is 10x off: $${totalDividedBy10.toFixed(2)}`);
}

main().catch(console.error);

