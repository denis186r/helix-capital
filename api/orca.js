const OPEN_TIMESTAMP = 1774675800;
const FEES_CARRYOVER_DEFAULT = 0.2082;

async function getFeesCarryover() {
  try {
    const url = process.env.UPSTASH_REDIS_REST_URL;
    const token = process.env.UPSTASH_REDIS_REST_TOKEN;
    if (!url || !token) return FEES_CARRYOVER_DEFAULT;
    const r = await fetch(`${url}/pipeline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify([['GET', 'orca_fees_carryover']])
    });
    const j = await r.json();
    const raw = j[0]?.result;
    if (raw == null) return FEES_CARRYOVER_DEFAULT;
    const val = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const num = typeof val === 'string' ? JSON.parse(val) : val;
    return (typeof num === 'number' && !isNaN(num)) ? num : FEES_CARRYOVER_DEFAULT;
  } catch(e) { return FEES_CARRYOVER_DEFAULT; }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const POSITION_ADDRESS = '2Kxm8V752pEpbDeDrUbRbWz7HhWUghDT4DztcySd7zE9';
  const HELIUS_RPC = `https://mainnet.helius-rpc.com/?api-key=56f4b0e7-f504-4783-84cc-8ac64be0b054`;
  const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const APY_FALLBACK = 30;

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

  function readU64LE(buf, offset) {
    let r = 0n;
    for (let i = 0; i < 8; i++) r += BigInt(buf[offset+i]) << BigInt(i*8);
    return r;
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
        params:[pubkey, { encoding:'base64' }] })
    });
    const j = await r.json();
    if (j.error) throw new Error(j.error.message);
    return j.result?.value;
  }

  const carryover = await getFeesCarryover();
  const daysActive = Math.max(0.1, (Date.now() / 1000 - OPEN_TIMESTAMP) / 86400);

  try {
    // --- Read position account ---
    const posAcc = await getAccount(POSITION_ADDRESS);
    if (!posAcc) throw new Error('Position not found');
    const pos = Buffer.from(posAcc.data[0], 'base64');

    // Verified position offsets:
    const poolPubkey  = base58Encode(pos.slice(8, 40));  // offset 8: whirlpool pubkey
    const posLiquidity   = readU128LE(pos, 72);  // offset 72: liquidity
    const tickLower      = readI32LE(pos, 88);   // offset 88: tickLowerIndex (confirmed)
    const tickUpper      = readI32LE(pos, 92);   // offset 92: tickUpperIndex (confirmed)
    const fgCheckpointA  = readU128LE(pos, 96);  // offset 96: feeGrowthCheckpointA
    const feeOwedA_raw   = readU64LE(pos, 112);  // offset 112: feeOwedA
    const fgCheckpointB  = readU128LE(pos, 120); // offset 120: feeGrowthCheckpointB
    const feeOwedB_raw   = readU64LE(pos, 136);  // offset 136: feeOwedB

    // --- Read pool account ---
    const poolAcc = await getAccount(poolPubkey);
    if (!poolAcc) throw new Error('Pool not found');
    const pool = Buffer.from(poolAcc.data[0], 'base64');

    // Verified pool offsets:
    const sqrtPriceX64    = readU128LE(pool, 65);   // offset 65: sqrtPrice Q64.64 (confirmed via feeRate@45, tick@81)
    const currentTick     = readI32LE(pool, 81);    // offset 81: tickCurrentIndex (confirmed)
    const feeGrowthGlobalA = readU128LE(pool, 165); // offset 165: feeGrowthGlobalA
    const feeGrowthGlobalB = readU128LE(pool, 245); // offset 245: feeGrowthGlobalB

    const inRange = currentTick >= tickLower && currentTick <= tickUpper;

    // === Real APY calculation ===
    // Formula: fees = feeOwed + (feeGrowthGlobal - checkpoint) * liquidity >> 64
    // Valid when price hasn't crossed tick bounds since position opened (our normal case).
    // Orca uses Q64.64 format → divide by 2^64 (not 2^128 like Uniswap V3).
    let apyReal = null;
    let feesUSD = null;
    let posValueUSD = null;

    try {
      const Q64  = 2n ** 64n;
      const Q128 = 2n ** 128n; // for wraparound check

      // Handle potential u128 wraparound
      const deltaA = feeGrowthGlobalA >= fgCheckpointA
        ? feeGrowthGlobalA - fgCheckpointA
        : Q128 - fgCheckpointA + feeGrowthGlobalA;
      const deltaB = feeGrowthGlobalB >= fgCheckpointB
        ? feeGrowthGlobalB - fgCheckpointB
        : Q128 - fgCheckpointB + feeGrowthGlobalB;

      const totalFeeA = feeOwedA_raw + (deltaA * posLiquidity / Q64); // raw VCHF (9 dec)
      const totalFeeB = feeOwedB_raw + (deltaB * posLiquidity / Q64); // raw USDC (6 dec)

      const feeVCHF = Number(totalFeeA) / 1e9;
      const feeUSDC = Number(totalFeeB) / 1e6;

      // VCHF price in USDC:
      // sqrtPriceX64 is Q64.64 → actual_sqrtPrice = sqrtPriceX64 / 2^64
      // price_raw = actual_sqrtPrice^2 = USDC_raw / VCHF_raw
      // price_human (USDC per VCHF) = price_raw * 10^decVCHF / 10^decUSDC = price_raw * 1000
      const sqC = Number(sqrtPriceX64) / Number(Q64);
      const priceVCHF = sqC * sqC * 1000; // 1 VCHF = X USDC

      feesUSD = feeVCHF * priceVCHF + feeUSDC;

      // Position value using Orca's amount formulas:
      // amount_A_raw = L * (1/sqC - 1/sqU)  [VCHF raw]
      // amount_B_raw = L * (sqC - sqL)      [USDC raw]
      // where sqL/sqU = sqrt(1.0001^tick) in same float scale as sqC
      const sqL = Math.pow(1.0001, tickLower / 2);
      const sqU = Math.pow(1.0001, tickUpper / 2);
      const L = Number(posLiquidity);

      let amtA_raw, amtB_raw;
      if (sqC <= sqL) {
        amtA_raw = L * (1/sqL - 1/sqU); amtB_raw = 0;
      } else if (sqC >= sqU) {
        amtA_raw = 0; amtB_raw = L * (sqU - sqL);
      } else {
        amtA_raw = L * (1/sqC - 1/sqU);
        amtB_raw = L * (sqC - sqL);
      }

      posValueUSD = (amtA_raw / 1e9) * priceVCHF + (amtB_raw / 1e6);

      if (posValueUSD > 1 && feesUSD >= 0 && daysActive > 0.1) {
        const apy = (feesUSD / posValueUSD) / daysActive * 365 * 100;
        if (apy >= 1 && apy <= 500) apyReal = apy.toFixed(1);
      }
    } catch(calcErr) {
      // Calculation failed, fall through to fallback
    }

    const apyFinal = inRange ? (apyReal ?? String(APY_FALLBACK)) : '0.0';
    const apyForFees = parseFloat(inRange ? (apyReal ?? APY_FALLBACK) : 0);
    const feesPct = (carryover + apyForFees * daysActive / 365).toFixed(4);

    return res.status(200).json({
      inRange,
      apy: apyFinal,
      feesPct,
      tickLower, tickUpper, currentTick,
      poolAddress: poolPubkey,
      feesUSD:     feesUSD    !== null ? feesUSD.toFixed(4)    : null,
      posValueUSD: posValueUSD !== null ? posValueUSD.toFixed(2) : null,
      source: apyReal ? 'on-chain-calculated' : 'fallback',
    });

  } catch(err) {
    const feesPct = (carryover + APY_FALLBACK * daysActive / 365).toFixed(4);
    return res.status(200).json({
      inRange: true, apy: String(APY_FALLBACK), feesPct,
      source: 'fallback', error: err.message
    });
  }
}
