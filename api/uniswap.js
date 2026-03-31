const OPEN_TIMESTAMP = 1774310400; // 24 Mar 2026 00:00 UTC
const APY_HARDCODED = 33; // Verified via Revert Finance (concentrated position)

function calcFeesPct(apy) {
  const days = Math.max(1, (Date.now() / 1000 - OPEN_TIMESTAMP) / 86400);
  return ((apy * days) / 365).toFixed(4);
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const POSITION_ID    = 5387381;
  const NFT_CONTRACT   = '0xC36442b4a4522E871399CD717aBDD847Ab11FE88';
  const POOL_ADDRESS   = '0x2f5e87c9312fa29aed5c179e456625d79015299c';
  const ARBITRUM_RPC   = 'https://arb1.arbitrum.io/rpc';

  // ABI selectors
  const SEL_POSITIONS  = '0x99fbab88'; // positions(uint256)
  const SEL_SLOT0      = '0x3850c7bd'; // slot0()
  const SEL_FG0        = '0xf3058399'; // feeGrowthGlobal0X128()
  const SEL_FG1        = '0x46141319'; // feeGrowthGlobal1X128()

  async function ethCall(to, data) {
    const resp = await fetch(ARBITRUM_RPC, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc:'2.0', method:'eth_call',
        params:[{ to, data }, 'latest'], id: 1 })
    });
    const json = await resp.json();
    if (json.error) throw new Error(json.error.message);
    return json.result;
  }

  try {
    // Read position NFT
    const posHex = POSITION_ID.toString(16).padStart(64, '0');
    const posResult = await ethCall(NFT_CONTRACT, SEL_POSITIONS + posHex);
    const hex = posResult.slice(2);
    const slots = [];
    for (let i = 0; i < hex.length; i += 64) slots.push(hex.slice(i, i + 64));
    if (slots.length < 12) throw new Error(`Only ${slots.length} slots`);

    const fee = parseInt(slots[4], 16);
    let tickLower = parseInt(slots[5], 16);
    if (tickLower >= 0x800000) tickLower -= 0x1000000;
    let tickUpper = parseInt(slots[6], 16);
    if (tickUpper >= 0x800000) tickUpper -= 0x1000000;
    const liquidity = BigInt('0x' + slots[7]);

    // feeGrowthInside (from position, last checkpoint)
    const feeGrowthInside0Last = BigInt('0x' + slots[8]);
    const feeGrowthInside1Last = BigInt('0x' + slots[9]);
    const tokensOwed0 = BigInt('0x' + slots[10]);
    const tokensOwed1 = BigInt('0x' + slots[11]);

    // Read slot0 (sqrtPriceX96 + currentTick)
    let currentTick = null;
    let sqrtPriceX96 = null;
    let inRange = liquidity > 0n;

    try {
      const s0 = await ethCall(POOL_ADDRESS, SEL_SLOT0);
      const s0hex = s0.slice(2);
      sqrtPriceX96 = BigInt('0x' + s0hex.slice(0, 64));
      currentTick = parseInt(s0hex.slice(64, 128), 16);
      if (currentTick >= 0x800000) currentTick -= 0x1000000;
      inRange = currentTick >= tickLower && currentTick <= tickUpper;
    } catch(e) {}

    // Read feeGrowthGlobal0/1 for snapshot delta APY (Uniswap V3 uses X128)
    let feeGrowthGlobal0 = null;
    let feeGrowthGlobal1 = null;
    try {
      const fg0 = await ethCall(POOL_ADDRESS, SEL_FG0);
      const fg1 = await ethCall(POOL_ADDRESS, SEL_FG1);
      if (fg0 && fg0.length >= 66) feeGrowthGlobal0 = BigInt('0x' + fg0.slice(2, 66)).toString();
      if (fg1 && fg1.length >= 66) feeGrowthGlobal1 = BigInt('0x' + fg1.slice(2, 66)).toString();
    } catch(e) {}

    const apyFinal = inRange ? APY_HARDCODED : 0;

    return res.status(200).json({
      inRange,
      apy: apyFinal.toFixed(1),
      feesPct: calcFeesPct(inRange ? APY_HARDCODED : 0),
      feeTier: (fee / 10000).toFixed(2),
      tickLower, tickUpper, currentTick,
      liquidity: liquidity.toString(),
      sqrtPriceX96: sqrtPriceX96?.toString() ?? null,
      feeGrowthGlobal0,
      feeGrowthGlobal1,
      feeGrowthInside0Last: feeGrowthInside0Last.toString(),
      feeGrowthInside1Last: feeGrowthInside1Last.toString(),
      tokensOwed0: tokensOwed0.toString(),
      tokensOwed1: tokensOwed1.toString(),
      source: 'arbitrum-rpc'
    });

  } catch(err) {
    return res.status(200).json({
      inRange: true, apy: APY_HARDCODED.toFixed(1),
      feesPct: calcFeesPct(APY_HARDCODED),
      feeTier: '0.05', source: 'fallback', error: err.message
    });
  }
}
