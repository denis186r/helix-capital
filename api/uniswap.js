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
      liquidityUSD
      tickLower { id }
      tickUpper { id }
      pool {
        id
        tick
        totalValueLockedUSD
        dailySnapshots(first: 7, orderBy: timestamp, orderDirection: desc) {
          dailyTotalRevenueUSD
          totalValueLockedUSD
          timestamp
        }
      }
      cumulativeDepositUSD
      cumulativeRewardUSD
      snapshots(first: 1, orderBy: timestamp, orderDirection: desc) {
        timestamp
        liquidityUSD
      }
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
        errors: data.errors || null
      });
    }

    const pos = data.data.position;

    // Extract tick values from id (format: poolAddress#tickLower#tickUpper)
    const tickLowerVal = parseInt(pos.tickLower?.id?.split('#')[1] || '0');
    const tickUpperVal = parseInt(pos.tickUpper?.id?.split('#')[1] || '0');
    const currentTick = parseInt(pos.pool?.tick || '0');
    const inRange = currentTick >= tickLowerVal && currentTick <= tickUpperVal;

    // APY from daily snapshots
    const snapshots = pos.pool?.dailySnapshots || [];
    let apy = null;
    if (snapshots.length > 0) {
      const avgRevenue = snapshots.reduce((s, d) => s + parseFloat(d.dailyTotalRevenueUSD || 0), 0) / snapshots.length;
      const tvl = parseFloat(snapshots[0]?.totalValueLockedUSD || 0);
      if (tvl > 0) apy = ((avgRevenue / tvl) * 365 * 100).toFixed(1);
    }

    // Fees as % of deposited
    const deposited = parseFloat(pos.cumulativeDepositUSD || 0);
    const rewards = parseFloat(pos.cumulativeRewardUSD || 0);
    const feesPct = deposited > 0 && rewards > 0 ? ((rewards / deposited) * 100).toFixed(4) : null;

    res.status(200).json({
      inRange,
      apy,
      feesPct,
      feeTier: '0.30',
      liquidity: pos.liquidity,
      liquidityUSD: pos.liquidityUSD
    });

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
