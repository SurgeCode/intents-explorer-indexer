import fs from 'fs';

async function test() {
  const response = await fetch("https://1click.chaindefuser.com/v0/tokens");
  const tokens = await response.json();
  const tokenMap = new Map(tokens.map((t: any) => [t.assetId, t]));
  
  const lines = fs.readFileSync('./referral-fees.csv', 'utf-8').split('\n');
  
  console.log('Testing if fees need /10000 (basis points conversion):\n');
  
  for (let i = 1; i <= 5; i++) {
    const [timestamp, referral, asset, totalFeeStr] = lines[i].split(',');
    const token = tokenMap.get(asset);
    
    if (token) {
      const rawFee = parseFloat(totalFeeStr);
      
      const normalCalc = (rawFee / Math.pow(10, token.decimals)) * token.price;
      
      const bpsCalc = (rawFee / Math.pow(10, token.decimals) / 10000) * token.price;
      
      console.log(`Tx ${i} (${token.symbol}):`);
      console.log(`  Normal: $${normalCalc.toFixed(4)}`);
      console.log(`  With /10000: $${bpsCalc.toFixed(6)}`);
      console.log('');
    }
  }
  
  console.log('\nIf /10000 applied to all fees:');
  console.log(`  $4,768,949 / 10,000 = $${(4768949 / 10000).toFixed(2)}`);
}

test();
