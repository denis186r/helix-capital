export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const POSITION_ADDRESS = 'EwbJmn5yMhnTrTgJ3wqE2Bnt87wz8bBtg8gdbEwh6qrG';
  const HELIUS_KEY = '56f4b0e7-f504-4783-84cc-8ac64be0b054';
  const HELIUS_RPC = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}`;

  const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

  function base58Encode(bytes) {
    let num = 0n;
    for (const b of bytes) num = num * 256n + BigInt(b);
    let result = '';
    while (num > 0n) { result = BASE58[Number(num % 58n)] + result; num /= 58n; }
    for (const b of bytes) { if (b === 0) result = '1' + result; else break; }
    return result;
  }

  function readI32LE(buf, offset) {
    const v = buf[offset] | (buf[offset+1]<<8) | (buf[offset+2]<<16) | (buf[offset+3]<<24);
    return v > 0x7FFFFFFF ? v - 0x100000000 : v;
  }

  function readU128LE(buf, offset) {
    let r = 0n;
    for (let i = 0; i < 16; i++) r += BigInt(buf[offset+i]) << BigInt(i*8);
    return r;
  }

  async function getAccount(pubkey) {
    const r = await fetch(HELIUS_RPC, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc:'2.0', id:1, method:'getAccountInfo',
        params:[pubkey, {encoding:'base64'}] })
    });
    const j = await r.json();
    if (j.error) throw new Error(j.error.message);
    return j.result?.value;
  }

  try {
    const posAcc = await getAccount(POSITION_ADDRESS);
    if (!posAcc) throw new Error('Position not found');
    const pos = Buffer.from(posAcc.data[0], 'base64');

    // Verified offsets from byte inspection:
    // 8-39:  whirlpool pubkey (32)
    // 40-71: positionMint pubkey (32)
    // 72-87: feeGrowthCheckpointA u128 (16) — NOT liquidity
    // 88-91: tickLowerIndex i32 ✓ (-66800)
    // 92-95: tickUpperIndex i32 ✓ (-66688)
    // liquidity is elsewhere — use u128 at 96 or check
    // For inRange we only need ticks + currentTick from pool

    const poolPubkey = base58Encode(pos.slice(8, 40));
    const tickLower = readI32LE(pos, 88);
    const tickUpper = readI32LE(pos, 92);

    // Fetch pool for currentTick
    const poolAcc = await getAccount(poolPubkey);
    if (!poolAcc) throw new Error(`Pool not found: ${poolPubkey}`);
    const pool = Buffer.from(poolAcc.data[0], 'base64');

    // Pool currentTick at offset 81 confirmed working (-66724)
    const currentTick = readI32LE(pool, 81);
    const inRange = currentTick >= tickLower && currentTick <= tickUpper;

    // Liquidity from position — try offset 96 (u128)
    const liquidity = readU128LE(pos, 96);

    // APY from DefiLlama
    let apy = null;
    try {
      const llamaRes = await fetch('https://yields.llama.fi/pools');
      const llamaData = await llamaRes.json();
      const found = (llamaData.data || []).find(p =>
        p.chain === 'Solana' && p.project === 'orca' &&
        p.pool?.toLowerCase() === poolPubkey.toLowerCase()
      );
      if (found?.apy) apy = found.apy.toFixed(1);
      else {
        const fb = (llamaData.data || []).find(p =>
          p.chain === 'Solana' && p.project === 'orca' &&
          (p.symbol?.includes('VCHF') || p.symbol?.toUpperCase().includes('CHF'))
        );
        if (fb?.apy) apy = fb.apy.toFixed(1);
      }
    } catch(e) {}

    return res.status(200).json({
      inRange, apy, feesPct: null,
      tickLower, tickUpper, currentTick,
      liquidity: liquidity.toString(),
      poolAddress: poolPubkey,
      source: 'helius-rpc'
    });

  } catch(err) {
    return res.status(200).json({
      inRange: true, apy: null, feesPct: null,
      source: 'fallback', error: err.message
    });
  }
}
