export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const POSITION_ID = 5387381;
  const POSITION_HEX = POSITION_ID.toString(16).padStart(64, '0');
  const NFT_CONTRACT = '0xC36442b4a4522E871399CD717aBDD847Ab11FE88';
  // positions(uint256) function selector
  const SELECTOR = '0x99fbab88';

  try {
    const arbRes = await fetch(
      `https://api.arbiscan.io/api?module=proxy&action=eth_call&to=${NFT_CONTRACT}&data=${SELECTOR}${POSITION_HEX}&tag=latest`
    );
    const arbData = await arbRes.json();

    if (!arbData.result || arbData.result === '0x') {
      throw new Error('No result from contract');
    }

    // ABI decode the result
    // positions() returns:
    // nonce(uint96), operator(address), token0(address), token1(address),
    // fee(uint24), tickLower(int24), tickUpper(int24), liquidity(uint128),
    // feeGrowthInside0LastX128(uint256), feeGrowthInside1LastX128(uint256),
    // tokensOwed0(uint128), tokensOwed1(uint128)
    const hex = arbData.result.slice(2);
    const slots = [];
    for (let i = 0; i < hex.length; i += 64) {
      slots.push(hex.slice(i, i + 64));
    }

    // slot 0: nonce (uint96) packed with operator (address) - nonce is first 12 bytes, operator last 20
    // slot 1: token0 address
    // slot 2: token1 address  
    // slot 3: fee (uint24) packed with tickLower (int24) and tickUpper (int24)
    // Actually each param is padded to 32 bytes in ABI encoding

    if (slots.length < 8) {
      throw new Error(`Not enough data: ${slots.length} slots`);
    }

    // Parse fee from slot 4 (index 4)
    const fee = parseInt(slots[4], 16);

    // Parse tickLower from slot 5 — int24 is signed
    let tickLower = parseInt(slots[5], 16);
    if (tickLower > 0x7FFFFF) tickLower -= 0x1000000; // sign extend int24

    // Parse tickUpper from slot 6
    let tickUpper = parseInt(slots[6], 16);
    if (tickUpper > 0x7FFFFF) tickUpper -= 0x1000000;

    // Parse liquidity from slot 7 (uint128)
    const liquidity = BigInt('0x' + slots[7]);

    // Now get current pool tick via Arbiscan
    // First get the pool address from the position
    // We'll use DefiLlama as fallback for current tick
    let inRange = liquidity > 0n;
    let currentTick = null;

    try {
      // Get pool tick from Uniswap V3 pool - ETH/WBTC 0.3% on Arbitrum
      const WETH = '0x82af49447d8a07e3bd95bd0d56f35241523fbab1';
      const WBTC = '0x2f2a2543b76a4166549f7aab2e75bef0aefc5b0f';
      // Pool address for WETH/WBTC 0.3% on Arbitrum
      const POOL = '0x2f5e87c9312fa29aed5c179e456625d79015299c';
      const SLOT0_SELECTOR = '0x3850c7bd'; // slot0()

      const poolRes = await fetch(
        `https://api.arbiscan.io/api?module=proxy&action=eth_call&to=${POOL}&data=${SLOT0_SELECTOR}&tag=latest`
      );
      const poolData = await poolRes.json();

      if (poolData.result && poolData.result !== '0x') {
        const poolHex = poolData.result.slice(2);
        // slot0 returns: sqrtPriceX96(uint160), tick(int24), ...
        // sqrtPriceX96 is 160 bits = 20 bytes, packed in first 32 bytes
        // tick is int24 packed after sqrtPriceX96
        const sqrtSlot = poolHex.slice(0, 64);
        const sqrtPrice = BigInt('0x' + sqrtSlot);
        // tick is in bits 160-183 of the packed value... actually in ABI encoding tick is slot 1
        const tickSlot = poolHex.slice(64, 128);
        currentTick = parseInt(tickSlot, 16);
        if (currentTick > 0x7FFFFF) currentTick -= 0x1000000;
        inRange = currentTick >= tickLower && currentTick <= tickUpper;
      }
    } catch(e) {}

    const feeTierPct = (fee / 10000).toFixed(2);
    const hasLiquidity = liquidity > 0n;

    return res.status(200).json({
      inRange,
      hasLiquidity,
      apy: null,
      feesPct: null,
      feeTier: feeTierPct,
      tickLower,
      tickUpper,
      currentTick,
      liquidity: liquidity.toString(),
      source: 'arbiscan-contract'
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
