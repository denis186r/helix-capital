export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const POSITION_ID = 5387381;
  const NFT_CONTRACT = '0xC36442b4a4522E871399CD717aBDD847Ab11FE88';
  const WETH_WBTC_POOL = '0x2f5e87c9312fa29aed5c179e456625d79015299c';
  const ARBITRUM_RPC = 'https://arb1.arbitrum.io/rpc';
  const POSITIONS_SELECTOR = '0x99fbab88';
  const SLOT0_SELECTOR = '0x3850c7bd';

  async function ethCall(to, data) {
    const resp = await fetch(ARBITRUM_RPC, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', method: 'eth_call',
        params: [{ to, data }, 'latest'], id: 1
      })
    });
    const json = await resp.json();
    if (json.error) throw new Error(json.error.message);
    return json.result;
  }

  try {
    const posHex = POSITION_ID.toString(16).padStart(64, '0');
    const posResult = await ethCall(NFT_CONTRACT, POSITIONS_SELECTOR + posHex);
    const hex = posResult.slice(2);
    const slots = [];
    for (let i = 0; i < hex.length; i += 64) slots.push(hex.slice(i, i + 64));
    if (slots.length < 7) throw new Error(`Only ${slots.length} slots`);

    const fee = parseInt(slots[4], 16);
    let tickLower = parseInt(slots[5], 16);
    if (tickLower >= 0x800000) tickLower -= 0x1000000;
    let tickUpper = parseInt(slots[6], 16);
    if (tickUpper >= 0x800000) tickUpper -= 0x1000000;
    const liquidity = BigInt('0x' + slots[7]);

    // Get current tick
    let currentTick = null;
    let inRange = liquidity > 0n;
    try {
      const slot0 = await ethCall(WETH_WBTC_POOL, SLOT0_SELECTOR);
      const s0hex = slot0.slice(2);
      currentTick = parseInt(s0hex.slice(64, 128), 16);
      if (currentTick >= 0x800000) currentTick -= 0x1000000;
      inRange = currentTick >= tickLower && currentTick <= tickUpper;
    } catch(e) {}

    // Get APY from DefiLlama for this specific pool
    let apy = null;
    try {
      const llamaRes = await fetch('https://yields.llama.fi/pools');
      const llamaData = await llamaRes.json();
      const pool = (llamaData.data || []).find(p =>
        p.chain === 'Arbitrum' &&
        p.project === 'uniswap-v3' &&
        p.pool?.toLowerCase() === WETH_WBTC_POOL.toLowerCase()
      );
      if (pool?.apy) apy = pool.apy.toFixed(1);
      else {
        // Fallback: find any ETH/WBTC pool on Arbitrum Uniswap
        const fallback = (llamaData.data || []).find(p =>
          p.chain === 'Arbitrum' &&
          p.project === 'uniswap-v3' &&
          p.symbol?.includes('WBTC') &&
          p.symbol?.includes('ETH')
        );
        if (fallback?.apy) apy = fallback.apy.toFixed(1);
      }
    } catch(e) {}

    return res.status(200).json({
      inRange,
      apy,
      feesPct: null,
      feeTier: (fee / 10000).toFixed(2),
      tickLower, tickUpper, currentTick,
      liquidity: liquidity.toString(),
      source: 'arbitrum-rpc'
    });

  } catch(err) {
    return res.status(200).json({
      inRange: true, apy: null, feesPct: null,
      feeTier: '0.05', source: 'fallback', error: err.message
    });
  }
}
