const OPEN_TIMESTAMP = 1774310400;
const APY_HARDCODED = 33;

function calcFeesPct(apy) {
  const days = Math.max(1, (Date.now() / 1000 - OPEN_TIMESTAMP) / 86400);
  return ((apy * days) / 365).toFixed(4);
}

async function getLastSnapshotAPY() {
  try {
    const url = process.env.KV_REST_API_URL;
    const token = process.env.KV_REST_API_TOKEN;
    if (!url || !token) return null;
    const r1 = await fetch(`${url}/pipeline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify([['GET', 'snapshot:index']])
    });
    const j1 = await r1.json();
    const raw1 = j1[0]?.result;
    if (!raw1) return null;
    const p1 = JSON.parse(raw1);
    const index = typeof p1 === 'string' ? JSON.parse(p1) : p1;
    if (!Array.isArray(index) || index.length === 0) return null;
    const lastKey = index[index.length - 1];
    const r2 = await fetch(`${url}/pipeline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify([['GET', `snapshot:${lastKey}`]])
    });
    const j2 = await r2.json();
    const raw2 = j2[0]?.result;
    if (!raw2) return null;
    const p2 = JSON.parse(raw2);
    const snap = typeof p2 === 'string' ? JSON.parse(p2) : p2;
    const apy = snap?.apy?.uniswap;
    return (typeof apy === 'number' && apy > 0) ? apy : null;
  } catch(e) { return null; }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const POSITION_ID  = 5387381;
  const NFT_CONTRACT = '0xC36442b4a4522E871399CD717aBDD847Ab11FE88';
  const POOL_ADDRESS = '0x2f5e87c9312fa29aed5c179e456625d79015299c';
  const ARBITRUM_RPC = 'https://arb1.arbitrum.io/rpc';

  const SEL_POSITIONS = '0x99fbab88';
  const SEL_SLOT0     = '0x3850c7bd';
  const SEL_FG0       = '0xf3058399';
  const SEL_FG1       = '0x46141319';

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
    const feeGrowthInside0Last = BigInt('0x' + slots[8]);
    const feeGrowthInside1Last = BigInt('0x' + slots[9]);
    const tokensOwed0 = BigInt('0x' + slots[10]);
    const tokensOwed1 = BigInt('0x' + slots[11]);

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

    let feeGrowthGlobal0 = null;
    let feeGrowthGlobal1 = null;
    try {
      const fg0 = await ethCall(POOL_ADDRESS, SEL_FG0);
      const fg1 = await ethCall(POOL_ADDRESS, SEL_FG1);
      if (fg0 && fg0.length >= 66) feeGrowthGlobal0 = BigInt('0x' + fg0.slice(2, 66)).toString();
      if (fg1 && fg1.length >= 66) feeGrowthGlobal1 = BigInt('0x' + fg1.slice(2, 66)).toString();
    } catch(e) {}

    // Lee APY real del último snapshot en lugar de usar hardcoded
    const lastAPY = await getLastSnapshotAPY();
    const apyDisplay = inRange ? (lastAPY ?? APY_HARDCODED) : 0;

    return res.status(200).json({
      inRange,
      apy: apyDisplay.toFixed(1),
      feesPct: calcFeesPct(inRange ? (lastAPY ?? APY_HARDCODED) : 0),
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
      source: lastAPY ? 'snapshot-delta' : 'fallback'
    });

  } catch(err) {
    return res.status(200).json({
      inRange: true, apy: APY_HARDCODED.toFixed(1),
      feesPct: calcFeesPct(APY_HARDCODED),
      feeTier: '0.05', source: 'fallback', error: err.message
    });
  }
}
