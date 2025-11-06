import fs from 'fs';

async function verify() {
  const response = await fetch("https://1click.chaindefuser.com/v0/tokens");
  const tokens = await response.json();
  const tokenMap = new Map(tokens.map((t: any) => [t.assetId, t]));
  
  const lines = fs.readFileSync('./referral-fees.csv', 'utf-8').split('\n');
  
  console.log('Verifying first few transactions:\n');
  
  for (let i = 1; i <= 5; i++) {
    const [timestamp, referral, asset, totalFeeStr] = lines[i].split(',');
    const token = tokenMap.get(asset);
    
    if (token) {
      const rawFee = parseFloat(totalFeeStr);
      const actualAmount = rawFee / Math.pow(10, token.decimals);
      const usdValue = actualAmount * token.price;
      
      console.log(`Transaction ${i}:`);
      console.log(`  Referral: ${referral}`);
      console.log(`  Asset: ${token.symbol}`);
      console.log(`  Raw Fee: ${totalFeeStr}`);
      console.log(`  Decimals: ${token.decimals}`);
      console.log(`  Actual Amount: ${actualAmount}`);
      console.log(`  Price: $${token.price}`);
      console.log(`  USD Value: $${usdValue.toFixed(2)}`);
      console.log('');
    }
  }
}

verify();
