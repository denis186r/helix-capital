export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const POSITION_ID = '5387381';
  const API_KEY = '0f725f2449c4f6f2604e60343492df1c';
  const URL = 'https://gateway.thegraph.com/api/subgraphs/id/FQ6JYszEKApsBpAmiHesRsd9Ygc6mzmpNRANeVQFYoVX';

  const query = `{
    position(id: "${POSITION_ID}") {
      liquidity
      token0 { symbol decimals }
      token1 { symbol decimals }
      tickLower { tickIdx }
      tickUpper { tickIdx }
      pool {
        tick
        feeTier
        token0Price
        poolDayData(first: 7, orderBy: date, orderDirection: desc) {
          feesUSD
          tvlUSD
          date
        }
      }
      collectedFeesToken0
      collectedFeesToken1
      depositedToken0
      depositedToken1
    }
  }`;

  try {
    const response = await fetch(URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${API_KEY}`
      },
      body: JSON.stringify({ query })
    });

    const data = await response.json();

    if (!data.data?.position) {
      return res.status(404).json({ error: 'Position not found' });
    }

    const pos = data.data.position;
    const currentTick = parseInt(pos.pool.tick);
    const tickLower = parseInt(pos.tickLower.tickIdx);
    const tickUpper = parseInt(pos.tickUpper.tickIdx);
    const inRange = currentTick >= tickLower && currentTick <= tickUpper;

    const dayData = pos.pool.poolDayData || [];
    let apy = null;
    if (dayData.length > 0) {
      const avgFees = dayData.reduce((s, d) => s + parseFloat(d.feesUSD || 0), 0) / dayData.length;
      const tvl = parseFloat(dayData[0]?.tvlUSD || 0);
      if (tvl > 0) apy = ((avgFees / tvl) * 365 * 100).toFixed(1);
    }

    const dep0 = parseFloat(pos.depositedToken0) || 0;
    const col0 = parseFloat(pos.collectedFeesToken0) || 0;
    const feesPct = dep0 > 0 ? ((col0 / dep0) * 100).toFixed(4) : null;

    const feeTier = (parseInt(pos.pool.feeTier) / 10000).toFixed(2);

    res.status(200).json({
      inRange,
      apy,
      feesPct,
      feeTier,
      token0: pos.token0.symbol,
      token1: pos.token1.symbol,
      liquidity: pos.liquidity
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
