export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
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
      cumulativeDepositUSD
      cumulativeRewardUSD
      pool {
        tick
        totalValueLockedUSD
        dailySnapshots(first: 7, orderBy: timestamp, orderDirection: desc) {
          dailyTotalRevenueUSD
          totalValueLockedUSD
        }
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

    const text = await response.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch(e) {
      return res.status(500).json({ error: 'Invalid JSON from subgraph', raw: text.slice(0, 300) });
    }

    if (data.errors) {
      return res.status(400).json({ error: 'GraphQL errors', errors: data.errors });
    }

    if (!data.data || !data.data.position) {
      return res.status(404).json({ error: 'Position not found', data: data });
    }

    const pos = data.data.position;

    // Parse ticks from id format: "poolAddress#lower#upper" or just the tick number
    let tickLowerVal = 0;
    let tickUpperVal = 0;
    try {
      const lId = pos.tickLower?.id || '';
      const uId = pos.tickUpper?.id || '';
      const lParts = lId.split('#');
      const uParts = uId.split('#');
      tickLowerVal = parseInt(lParts[lParts.length - 1] || '0');
      tickUpperVal = parseInt(uParts[uParts.length - 1] || '0');
    } catch(e) {}

    const currentTick = parseInt(pos.pool?.tick || '0');
    const inRange = tickUpperVal > tickLowerVal 
      ? (currentTick >= tickLowerVal && currentTick <= tickUpperVal)
      : true;

    // APY calculation
    const snapshots = pos.pool?.dailySnapshots || [];
    let apy = null;
    if (snapshots.length > 0) {
      const avgRevenue = snapshots.reduce((s, d) => s + parseFloat(d.dailyTotalRevenueUSD || 0), 0) / snapshots.length;
      const tvl = parseFloat(snapshots[0]?.totalValueLockedUSD || 0);
      if (tvl > 0) apy = ((avgRevenue / tvl) * 365 * 100).toFixed(1);
    }

    // Fees %
    const deposited = parseFloat(pos.cumulativeDepositUSD || 0);
    const rewards = parseFloat(pos.cumulativeRewardUSD || 0);
    const feesPct = (deposited > 0 && rewards > 0) ? ((rewards / deposited) * 100).toFixed(4) : null;

    return res.status(200).json({
      inRange,
      apy,
      feesPct,
      feeTier: '0.30',
      currentTick,
      tickLower: tickLowerVal,
      tickUpper: tickUpperVal,
      liquidity: pos.liquidity,
      liquidityUSD: pos.liquidityUSD
    });

  } catch(err) {
    return res.status(500).json({ error: err.message, stack: err.stack?.slice(0, 300) });
  }
}
