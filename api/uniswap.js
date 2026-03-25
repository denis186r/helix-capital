export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const POSITION_ID = '5387381';
  const SAFE_ADDRESS = '0x61d736F10F854712b5ffe9cFabdb967D18fa7aD9';

  try {
    // Use Uniswap V3 REST API on Arbitrum
    const uniRes = await fetch(
      `https://interface.gateway.uniswap.org/v1/graphql`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Origin': 'https://app.uniswap.org'
        },
        body: JSON.stringify({
          query: `{
            position(tokenId: "${POSITION_ID}", chain: ARBITRUM) {
              token0 { symbol }
              token1 { symbol }
              tickLower
              tickUpper
              pool {
                tick
                feeTier
                totalValueLockedUSD
              }
              liquidity
              collectedFeesToken0
              collectedFeesToken1
            }
          }`
        })
      }
    );

    if (!uniRes.ok) throw new Error(`Uniswap API: ${uniRes.status}`);
    const uniData = await uniRes.json();

    if (uniData.data?.position) {
      const pos = uniData.data.position;
      const currentTick = parseInt(pos.pool.tick);
      const inRange = currentTick >= pos.tickLower && currentTick <= pos.tickUpper;
      const feeTierPct = (parseInt(pos.pool.feeTier) / 10000).toFixed(2);

      return res.status(200).json({
        inRange,
        apy: null,
        feesPct: null,
        feeTier: feeTierPct,
        source: 'uniswap-api'
      });
    }

    throw new Error('No position data from Uniswap API');

  } catch(err) {
    // Final fallback: use Arbiscan to read position directly from contract
    try {
      const arbRes = await fetch(
        `https://api.arbiscan.io/api?module=proxy&action=eth_call&to=0xC36442b4a4522E871399CD717aBDD847Ab11FE88&data=0x99fbab88${POSITION_ID.toString(16).padStart(64,'0')}&tag=latest`
      );
      const arbData = await arbRes.json();

      if (arbData.result && arbData.result !== '0x') {
        const hex = arbData.result.slice(2);
        const tickLower = parseInt(hex.slice(128, 192), 16);
        const tickUpper = parseInt(hex.slice(192, 256), 16);
        const liquidity = parseInt(hex.slice(256, 320), 16);

        return res.status(200).json({
          inRange: liquidity > 0,
          apy: null,
          feesPct: null,
          feeTier: '0.30',
          liquidity: liquidity.toString(),
          source: 'arbiscan-contract'
        });
      }
    } catch(e2) {}

    // Ultimate fallback
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
