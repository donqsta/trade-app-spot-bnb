const rpcUrl = 'https://bsc-dataseed.binance.org/';

const walletAddress = '0xfc655C096cA4B26d485466CE50Dd5226d7954A05';

// balanceOf(address) function selector + padded address
const data = '0x70a08231' + '000000000000000000000000' + walletAddress.toLowerCase().replace('0x', '');

const tokens = {
  USDT: '0x55d398326f99059fF775485246999027B3197955',
  CAKE: '0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82',
  AAVE: '0xfb6115445Bff7b52FeB98650c87F44907e58F802'
};

async function queryBalance(name, contract) {
  const payload = {
    jsonrpc: '2.0',
    id: 1,
    method: 'eth_call',
    params: [
      {
        to: contract,
        data: data
      },
      'latest'
    ]
  };

  try {
    const res = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const json = await res.json();
    if (json.error) {
      console.error(`Error querying ${name}:`, json.error);
      return;
    }
    const hexResult = json.result;
    const balanceVal = BigInt(hexResult);
    console.log(`${name} raw balance: ${balanceVal.toString()}`);
    console.log(`${name} formatted balance (assuming 18 decimals): ${(Number(balanceVal) / 1e18).toFixed(6)}`);
  } catch (err) {
    console.error(`Failed to query ${name}:`, err);
  }
}

async function main() {
  console.log(`Checking token balances for wallet: ${walletAddress}...`);
  for (const [name, contract] of Object.entries(tokens)) {
    await queryBalance(name, contract);
  }
}

main();
