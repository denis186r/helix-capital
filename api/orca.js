export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const POSITION_ADDRESS = 'EwbJmn5yMhnTrTgJ3wqE2Bnt87wz8bBtg8gdbEwh6qrG';
  const HELIUS_KEY = '56f4b0e7-f504-4783-84cc-8ac64be0b054';
  const HELIUS_RPC = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}`;
  const HELIUS_API = `https://api.helius.xyz/v0`;

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

  function readU64LE(buf, offset) {
    let r = 0n;
    for (let i = 0; i < 8; i++) r += BigInt(buf[offset+i]) << BigInt(i*8);
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

  async function getRecentTransactions(address, limit = 10) {
    const r = await fetch(HELIUS_RPC, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1,
        method: 'getSignaturesForAddress',
        params: [address, { limit }]
      })
    });
    const j = await r.json();
    return j.result || [];
  }

  try {
    const posAcc = await getAccount(POSITION_ADDRESS);
    if (!posAcc) throw new Error('Position not found');
    const pos = Buffer.from(posAcc.data[0], 'base64');

    const poolPubkey = base58Encode(pos.slice(8, 40));
    const tickLower = readI32LE(pos, 88);
    const tickUpper = readI32LE(pos, 92);

    // feeOwedA at offset 104 (u64), feeOwedB at offset 120 (u64)
    const feeOwedA = readU64LE(pos, 104);
    const feeOwedB = readU64LE(pos, 120);

    const poolAcc = await getAccount(poolPubkey);
    if (!poolAcc) throw new Error('Pool not found');
    const pool = Buffer.from(poolAcc.data[0], 'base64');

    const currentTick = readI32LE(pool, 81);
    const inRange = currentTick >= tickLower && currentTick <= tickUpper;

    // Pool TVL: read token vault balances
    // Pool layout continued:
    // 85-116: tokenMintA pubkey (32)
    // 117-148: tokenMintB pubkey (32)  
    // 149-180: tokenVaultA pubkey (32)
    // 181-212: tokenVaultB pubkey (32)
    const tokenVaultA = base58Encode(pool.slice(149, 181));
    const tokenVaultB = base58Encode(pool.slice(181, 213));

    // Get vault balances to estimate TVL
    let tvlUSD = 0;
    let apy = null;

    try {
      const [vaultAInfo, vaultBInfo] = await Promise.all([
        getAccount(tokenVaultA),
        getAccount(tokenVaultB)
      ]);

      // SPL token account: amount at offset 64 (u64 LE)
      if (vaultAInfo && vaultBInfo) {
        const vaultAData = Buffer.from(vaultAInfo.data[0], 'base64');
        const vaultBData = Buffer.from(vaultBInfo.data[0], 'base64');
        const amountA = readU64LE(vaultAData, 64);
        const amountB = readU64LE(vaultBData, 64);

        // VCHF has 6 decimals, USDC has 6 decimals
        const amountAHuman = Number(amountA) / 1e6;
        const amountBHuman = Number(amountB) / 1e6;

        // VCHF ≈ 1.11 USD (CHF to USD), USDC = 1 USD
        const vchfPrice = 1.11;
        tvlUSD = (amountAHuman * vchfPrice) + amountBHuman;

        // Get recent swap transactions to estimate 24h fees
        const sigs = await getRecentTransactions(poolPubkey, 50);
        const now = Date.now() / 1000;
        const oneDayAgo = now - 86400;
        const recentSigs = sigs.filter(s => s.blockTime && s.blockTime > oneDayAgo);

        // Estimate: each swap generates ~0.01% fee on avg ~$500 volume
        // With fee rate from pool data
        const feeRate = readI32LE(pool, 45) / 1000000; // feeRate is basis points / 10000
        const estimatedSwaps = recentSigs.length;
        const avgSwapVolumeUSD = 200; // conservative estimate
        const dailyFeesUSD = estimatedSwaps * avgSwapVolumeUSD * feeRate;

        if (tvlUSD > 0 && dailyFeesUSD > 0) {
          apy = ((dailyFeesUSD / tvlUSD) * 365 * 100).toFixed(1);
        }
      }
    } catch(e) {}

    // Fallback APY from position's accrued fees
    if (!apy && feeOwedA > 0n) {
      // feeOwedA in VCHF (6 decimals)
      const feesUSD = (Number(feeOwedA) / 1e6) * 1.11 + (Number(feeOwedB) / 1e6);
      // Estimate position value
      const positionValue = 25; // ~$25 initial investment
      if (feesUSD > 0 && positionValue > 0) {
        // Annualize based on days active
        const daysActive = Math.max(1, (Date.now()/1000 - 1742774400) / 86400);
        apy = ((feesUSD / positionValue) * (365 / daysActive) * 100).toFixed(1);
      }
    }

    return res.status(200).json({
      inRange, apy, feesPct: null,
      tickLower, tickUpper, currentTick,
      feeOwedA: feeOwedA.toString(),
      feeOwedB: feeOwedB.toString(),
      tvlUSD: tvlUSD.toFixed(0),
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
