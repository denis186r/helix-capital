export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const POSITION_ADDRESS = 'EwbJmn5yMhnTrTgJ3wqE2Bnt87wz8bBtg8gdbEwh6qrG';
  const POOL_ADDRESS = 'CsPc6gYMxnNJHo9JBRHBDeDwLniXbLxAHCLMHcPe4TiUk';
  const HELIUS_KEY = '56f4b0e7-f504-4783-84cc-8ac64be0b054';
  const HELIUS_RPC = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}`;

  async function getAccountInfo(pubkey) {
    const resp = await fetch(HELIUS_RPC, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'getAccountInfo',
        params: [pubkey, { encoding: 'base64' }]
      })
    });
    const json = await resp.json();
    if (json.error) throw new Error(json.error.message);
    return json.result?.value;
  }

  function readInt32LE(buf, offset) {
    const val = buf[offset] | (buf[offset+1] << 8) | (buf[offset+2] << 16) | (buf[offset+3] << 24);
    return val > 0x7FFFFFFF ? val - 0x100000000 : val;
  }

  function readUint128LE(buf, offset) {
    let result = 0n;
    for (let i = 0; i < 16; i++) {
      result += BigInt(buf[offset + i]) << BigInt(i * 8);
    }
    return result;
  }

  try {
    // Fetch position and pool accounts in parallel
    const [posAccount, poolAccount] = await Promise.all([
      getAccountInfo(POSITION_ADDRESS),
      getAccountInfo(POOL_ADDRESS)
    ]);

    if (!posAccount || !poolAccount) {
      throw new Error('Account not found');
    }

    // Decode position data (Orca Whirlpool Position layout)
    // Layout: discriminator(8) + whirlpool(32) + positionMint(32) + liquidity(16) + 
    //         priceRange lower/upper (16+16) + tickLowerIndex(4) + tickUpperIndex(4) + ...
    const posData = Buffer.from(posAccount.data[0], 'base64');
    const poolData = Buffer.from(poolAccount.data[0], 'base64');

    // Position offsets (after 8-byte discriminator):
    // whirlpool: 8..40
    // positionMint: 40..72
    // liquidity: 72..88 (u128 LE)
    // tickLowerIndex: 88..92 (i32 LE)  — actually feeGrowthCheckpointA first
    // Orca position layout from source:
    // 0-7: discriminator
    // 8-39: whirlpool pubkey
    // 40-71: position mint pubkey
    // 72-87: liquidity (u128)
    // 88-103: feeGrowthCheckpointA (u128)
    // 104-119: feeOwedA (u64 + padding)
    // 120-135: feeGrowthCheckpointB (u128)
    // 136-151: feeOwedB (u64 + padding)
    // 152-155: tickLowerIndex (i32)
    // 156-159: tickUpperIndex (i32)

    const liquidity = readUint128LE(posData, 72);
    const tickLower = readInt32LE(posData, 152);
    const tickUpper = readInt32LE(posData, 156);

    // Pool layout (Whirlpool):
    // 0-7: discriminator
    // 8-39: whirlpoolsConfig
    // 40-47: whirlpoolBump
    // 48-49: tickSpacing
    // 50-57: tickSpacingAge (padding)
    // 58-59: feeRate
    // 60-67: protocolFeeRate
    // 68-83: liquidity (u128)
    // 84-115: sqrtPrice (u128)
    // 116-119: tickCurrentIndex (i32)
    const currentTick = readInt32LE(poolData, 116);
    const inRange = currentTick >= tickLower && currentTick <= tickUpper;

    // Get APY from DefiLlama
    let apy = null;
    try {
      const llamaRes = await fetch('https://yields.llama.fi/pools');
      const llamaData = await llamaRes.json();
      const pool = (llamaData.data || []).find(p =>
        p.chain === 'Solana' &&
        p.project === 'orca' &&
        p.pool?.toLowerCase() === POOL_ADDRESS.toLowerCase()
      );
      if (pool?.apy) apy = pool.apy.toFixed(1);
      else {
        const fallback = (llamaData.data || []).find(p =>
          p.chain === 'Solana' &&
          p.project === 'orca' &&
          (p.symbol?.includes('VCHF') || p.symbol?.includes('CHF'))
        );
        if (fallback?.apy) apy = fallback.apy.toFixed(1);
      }
    } catch(e) {}

    return res.status(200).json({
      inRange,
      apy,
      feesPct: null,
      tickLower,
      tickUpper,
      currentTick,
      liquidity: liquidity.toString(),
      hasLiquidity: liquidity > 0n,
      source: 'helius-rpc'
    });

  } catch(err) {
    return res.status(200).json({
      inRange: true,
      apy: null,
      feesPct: null,
      source: 'fallback',
      error: err.message
    });
  }
}
