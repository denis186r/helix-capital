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
      id
      liquidity
      hashOpened
      tickLower { tickIndex }
      tickUpper { tickIndex }
      pool {
        tick
        activeLiquidity
        totalValueLockedUSD
        dailySnapshots(first: 7, orderBy: timestamp, orderDirection: desc) {
          dailyTotalRevenueUSD
          totalValueLockedUSD
          timestamp
        }
      }
      withdrawnTokenAmounts
      depositedTokenAmounts
      cumulativeRewardUSD
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
      return res.status(404).json({ 
        error: 'Position not found',
        debug: {
          hasData: !!data.data,
          keys: data.data ? Object.keys(data.data) : [],
          errors: data.errors || null,
          raw: JSON.stringify(data).slice(0, 500)
        }
      });
    }

    const pos = data.data.position;
    const currentTick = parseInt(pos.pool.tick);
    const tickLower = parseInt(pos.tickLower.tickIndex);
    const tickUpper = parseInt(pos.tickUpper.tickIndex);
    const inRange = currentTick >= tickLower && currentTick <= tickUpper;

    const snapshots = pos.pool.dailySnapshots || [];
    let apy = null;
    if (snapshots.length > 0) {
      const avgRevenue = snapshots.reduce((s, d) => s + parseFloat(d.dailyTotalRevenueUSD || 0), 0) / snapshots.length;
      const tvl = parseFloat(snapshots[0]?.totalValueLockedUSD || 0);
      if (tvl > 0) apy = ((avgRevenue / tvl) * 365 * 100).toFixed(1);
    }

    const deposited = pos.depositedTokenAmounts || [];
    const rewards = parseFloat(pos.cumulativeRewardUSD || 0);
    const tvl = parseFloat(pos.pool.totalValueLockedUSD || 0);
    const feesPct = tvl > 0 && rewards > 0 ? ((rewards / tvl) * 100).toFixed(4) : null;

    res.status(200).json({
      inRange,
      apy,
      feesPct,
      feeTier: '0.30',
      liquidity: pos.liquidity
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
