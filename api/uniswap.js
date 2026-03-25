export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const POSITION_ID = 5387381;
  const NFT_CONTRACT = '0xC36442b4a4522E871399CD717aBDD847Ab11FE88';
  const WETH_WBTC_POOL = '0x2f5e87c9312fa29aed5c179e456625d79015299c';
  const ARBITRUM_RPC = 'https://arb1.arbitrum.io/rpc';

  // positions(uint256) selector
  const POSITIONS_SELECTOR = '0x99fbab88';
  // slot0() selector
  const SLOT0_SELECTOR = '0x3850c7bd';

  async function ethCall(to, data) {
    const resp = await fetch(ARBITRUM_RPC, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'eth_call',
        params: [{ to, data }, 'latest'],
        id: 1
      })
    });
    const json = await resp.json();
    if (json.error) throw new Error(json.error.message);
    return json.result;
  }

  try {
    const posHex = POSITION_ID.toString(16).padStart(64, '0');

    // Call positions(tokenId) on NFT contract
    const posResult = await ethCall(NFT_CONTRACT, POSITIONS_SELECTOR + posHex);

    if (!posResult || posResult === '0x') {
      throw new Error('Empty result from positions()');
    }

    const hex = posResult.slice(2);
    const slots = [];
    for (let i = 0; i < hex.length; i += 64) {
      slots.push(hex.slice(i, i + 64));
    }

    if (slots.length < 7) {
      throw new Error(`Only ${slots.length} slots returned`);
    }

    // ABI: nonce, operator, token0, token1, fee, tickLower, tickUpper, liquidity, ...
    const fee = parseInt(slots[4], 16);

    let tickLower = parseInt(slots[5], 16);
    if (tickLower >= 0x800000) tickLower = tickLower - 0x1000000;

    let tickUpper = parseInt(slots[6], 16);
    if (tickUpper >= 0x800000) tickUpper = tickUpper - 0x1000000;

    const liquidity = BigInt('0x' + slots[7]);

    // Get current pool tick via slot0()
    let currentTick = null;
    let inRange = liquidity > 0n;

    try {
      const slot0Result = await ethCall(WETH_WBTC_POOL, SLOT0_SELECTOR);
      if (slot0Result && slot0Result !== '0x') {
        const s0hex = slot0Result.slice(2);
        // slot0 returns packed: sqrtPriceX96(uint160) + tick(int24) + ...
        // In ABI encoding: slot 0 = sqrtPriceX96, slot 1 = tick
        const tickHex = s0hex.slice(64, 128);
        currentTick = parseInt(tickHex, 16);
        if (currentTick >= 0x800000) currentTick = currentTick - 0x1000000;
        inRange = currentTick >= tickLower && currentTick <= tickUpper;
      }
    } catch(e) {}

    const feeTierPct = (fee / 10000).toFixed(2);

    return res.status(200).json({
      inRange,
      apy: null,
      feesPct: null,
      feeTier: feeTierPct,
      tickLower,
      tickUpper,
      currentTick,
      liquidity: liquidity.toString(),
      hasLiquidity: liquidity > 0n,
      source: 'arbitrum-rpc'
    });

  } catch(err) {
    return res.status(200).json({
      inRange: true,
      apy: null,
      feesPct: null,
      feeTier: '0.30',
      source: 'fallback',
      error: err.message
    });
  }
}
