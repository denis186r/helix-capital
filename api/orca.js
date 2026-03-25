export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const POSITION = 'EwbJmn5yMhnTrTgJ3wqE2Bnt87wz8bBtg8gdbEwh6qrG';
  const POOL = 'CsPc6gYMxnNJHo9JBRHBDeDwLniXbLxAHCLMHcPe4TiUk';

  try {
    const [posRes, poolRes] = await Promise.all([
      fetch(`https://api.mainnet.orca.so/v1/position/${POSITION}`),
      fetch(`https://api.mainnet.orca.so/v1/whirlpool/${POOL}`)
    ]);

    let posData = null;
    let poolData = null;

    if (posRes.ok) posData = await posRes.json();
    if (poolRes.ok) poolData = await poolRes.json();

    if (!posData && !poolData) {
      return res.status(200).json({
        inRange: true,
        apy: '24.0',
        feesPct: null,
        source: 'fallback'
      });
    }

    let inRange = true;
    let apy = null;
    let feesPct = null;

    if (posData) {
      const tickCurrent = poolData?.tickCurrentIndex ?? null;
      const tickLower = posData?.tickLowerIndex ?? null;
      const tickUpper = posData?.tickUpperIndex ?? null;
      if (tickCurrent !== null && tickLower !== null && tickUpper !== null) {
        inRange = tickCurrent >= tickLower && tickCurrent <= tickUpper;
      }
      if (posData.feeOwedA !== undefined && posData.liquidity) {
        feesPct = ((parseFloat(posData.feeOwedA) / parseFloat(posData.liquidity)) * 100).toFixed(4);
      }
    }

    if (poolData?.apy) {
      apy = parseFloat(poolData.apy * 100).toFixed(1);
    }

    res.status(200).json({
      inRange,
      apy,
      feesPct,
      source: 'live'
    });

  } catch (err) {
    res.status(200).json({
      inRange: true,
      apy: '24.0',
      feesPct: null,
      source: 'fallback',
      error: err.message
    });
  }
}
