export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const ARBITRUM_RPC = 'https://arb1.arbitrum.io/rpc';
  const HELIUS_KEY = '56f4b0e7-f504-4783-84cc-8ac64be0b054';
  const HELIUS_RPC = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}`;
  const NFT_CONTRACT = '0xC36442b4a4522E871399CD717aBDD847Ab11FE88';
  const POSITION_ID = 5387381;
  const ORCA_POSITION = 'EwbJmn5yMhnTrTgJ3wqE2Bnt87wz8bBtg8gdbEwh6qrG';
  const WETH_WBTC_POOL = '0x2f5e87c9312fa29aed5c179e456625d79015299c';

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

  function readU64LE(buf, offset) {
    let r = 0n;
    for (let i = 0; i < 8; i++) r += BigInt(buf[offset+i]) << BigInt(i*8);
    return r;
  }

  async function ethCall(to, data) {
    const r = await fetch(ARBITRUM_RPC, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc:'2.0', method:'eth_call', params:[{to, data},'latest'], id:1 })
    });
    const j = await r.json();
    return j.result;
  }

  async function getSolanaAccount(pubkey) {
    const r = await fetch(HELIUS_RPC, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc:'2.0', id:1, method:'getAccountInfo',
        params:[pubkey, {encoding:'base64'}] })
    });
    const j = await r.json();
    return j.result?.value;
  }

  async function getPrices() {
    try {
      const r = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=ethereum,bitcoin&vs_currencies=usd');
      const d = await r.json();
      return { eth: d.ethereum?.usd || 3000, btc: d.bitcoin?.usd || 60000 };
    } catch(e) { return { eth: 3000, btc: 60000 }; }
  }

  const prices = await getPrices();
  const START = new Date('2026-03-24').getTime() / 1000;
  const daysActive = Math.max(1, (Date.now()/1000 - START) / 86400);

  // ── ARBITRUM ────────────────────────────────────────────────────────
  let uniFeesUSD = 0, uniFeePct = null, uniAPY = null, uniInRange = true;

  try {
    const posHex = POSITION_ID.toString(16).padStart(64, '0');
    const posResult = await ethCall(NFT_CONTRACT, '0x99fbab88' + posHex);
    const hex = posResult.slice(2);
    const slots = [];
    for (let i = 0; i < hex.length; i += 64) slots.push(hex.slice(i, i + 64));

    if (slots.length >= 12) {
      // Uniswap V3 positions() returns 12 slots:
      // 0: nonce+operator, 1: token0, 2: token1, 3: fee+tickLower+tickUpper (packed)
      // 4: fee, 5: tickLower, 6: tickUpper, 7: liquidity
      // 8: feeGrowthInside0LastX128, 9: feeGrowthInside1LastX128
      // 10: tokensOwed0 (uint128), 11: tokensOwed1 (uint128)
      const owed0 = BigInt('0x' + slots[10]); // wBTC (8 decimals)
      const owed1 = BigInt('0x' + slots[11]); // ETH (18 decimals)

      const owed0USD = (Number(owed0) / 1e8) * prices.btc;
      const owed1USD = (Number(owed1) / 1e18) * prices.eth;
      uniFeesUSD = owed0USD + owed1USD;

      // Sanity check — max $500 in fees for a $50 position
      if (uniFeesUSD > 500) uniFeesUSD = 0;

      let tickLower = parseInt(slots[5], 16);
      if (tickLower >= 0x800000) tickLower -= 0x1000000;
      let tickUpper = parseInt(slots[6], 16);
      if (tickUpper >= 0x800000) tickUpper -= 0x1000000;

      const slot0 = await ethCall(WETH_WBTC_POOL, '0x3850c7bd');
      const s0hex = slot0.slice(2);
      let currentTick = parseInt(s0hex.slice(64, 128), 16);
      if (currentTick >= 0x800000) currentTick -= 0x1000000;
      uniInRange = currentTick >= tickLower && currentTick <= tickUpper;

      // Try Revert API for real position APY
      try {
        const revertRes = await fetch(
          `https://api.revert.finance/v1/positions?tokenId=${POSITION_ID}&network=arbitrum`
        );
        if (revertRes.ok) {
          const rd = await revertRes.json();
          if (rd?.position?.feeApr) uniAPY = (rd.position.feeApr * 100).toFixed(1);
        }
      } catch(e) {}
    }
  } catch(e) {}

  // ── SOLANA ──────────────────────────────────────────────────────────
  let orcaFeesUSD = 0, orcaFeePct = null, orcaAPY = null, orcaInRange = true;

  try {
    const posAcc = await getSolanaAccount(ORCA_POSITION);
    if (posAcc) {
      const pos = Buffer.from(posAcc.data[0], 'base64');
      const poolPubkey = base58Encode(pos.slice(8, 40));

      const tickLower = readI32LE(pos, 88);
      const tickUpper = readI32LE(pos, 92);

      // Debug all u64 values in position to find fees
      // From earlier inspection, bytes 64-88 had:
      // offset_88=-66800 (tickLower confirmed)
      // Before ticks: feeGrowth checkpoints (u128 x2 = 32 bytes) + feeOwed (u64 x2 = 16 bytes)
      // Layout: disc(8)+whirlpool(32)+mint(32) = 72 bytes before data
      // Then: liquidity(16) + feeGrowthA(16) + feeOwedA(8) + feeGrowthB(16) + feeOwedB(8) = 64 bytes
      // 72 + 64 = 136... but ticks are at 88/92
      // So actual layout after mint(72):
      // 72: feeGrowthA(16) → ends at 88 → tickLower at 88 ✓
      // After ticks at 92+4=96: liquidity? rewardInfos?
      // Actually Orca position layout (from SDK):
      // whirlpool(32) positionMint(32) liquidity(16) feeGrowthCheckpointA(16)
      // feeOwedA(8) feeGrowthCheckpointB(16) feeOwedB(8) tickLowerIndex(4) tickUpperIndex(4)
      // = 8+32+32+16+16+8+16+8+4+4 = 144... but ticks confirmed at 88/92
      // Reversed: ticks might be BEFORE feeGrowth
      // disc(8)+whirlpool(32)+mint(32) = 72
      // Then tickLower(4) tickUpper(4) = 80 ... no ticks at 88
      // Let me try: 72 + liquidity(16) = 88 → ticks at 88 ✓ means liquidity IS at 72
      // So: liquidity(16 bytes, 72-87) → tickLower(4, 88-91) → tickUpper(4, 92-95)
      // → feeGrowthCheckpointA(16, 96-111) → feeOwedA(8, 112-119)
      // → feeGrowthCheckpointB(16, 120-135) → feeOwedB(8, 136-143)

      const feeOwedA = readU64LE(pos, 112); // VCHF (6 decimals, ~1.11 USD)
      const feeOwedB = readU64LE(pos, 136); // USDC (6 decimals)

      const feeOwedAUSD = (Number(feeOwedA) / 1e6) * 1.11;
      const feeOwedBUSD = Number(feeOwedB) / 1e6;
      orcaFeesUSD = feeOwedAUSD + feeOwedBUSD;

      // Sanity check
      if (orcaFeesUSD > 500) orcaFeesUSD = 0;

      const INITIAL_USD = 50;
      if (orcaFeesUSD > 0) {
        orcaFeePct = ((orcaFeesUSD / INITIAL_USD) * 100).toFixed(4);
      }

      const poolAcc = await getSolanaAccount(poolPubkey);
      if (poolAcc) {
        const pool = Buffer.from(poolAcc.data[0], 'base64');
        const currentTick = readI32LE(pool, 81);
        orcaInRange = currentTick >= tickLower && currentTick <= tickUpper;

        const tvlRaw = readU64LE(pool, 168);
        const tvlUSD = Number(tvlRaw) / 1e6;
        const sigsRes = await fetch(HELIUS_RPC, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc:'2.0', id:1, method:'getSignaturesForAddress',
            params:[poolPubkey, {limit:100}] })
        });
        const sigsData = await sigsRes.json();
        const sigs = sigsData.result || [];
        const now = Date.now()/1000;
        const swaps24h = sigs.filter(s => s.blockTime && s.blockTime > now - 86400).length;
        const feeRateRaw = pool[45] | (pool[46] << 8);
        const feeRate = feeRateRaw / 1000000;
        const dailyFeesUSD = swaps24h * 1000 * feeRate;
        if (tvlUSD > 0 && dailyFeesUSD > 0) {
          orcaAPY = ((dailyFeesUSD / tvlUSD) * 365 * 100).toFixed(1);
        }
      }
    }
  } catch(e) {}

  // ── COMBINED ────────────────────────────────────────────────────────
  const totalFeesUSD = uniFeesUSD + orcaFeesUSD;
  const TOTAL_INITIAL = 100;

  let totalFeePct = null;
  let annualizedReturn = null;

  if (totalFeesUSD > 0) {
    totalFeePct = ((totalFeesUSD / TOTAL_INITIAL) * 100).toFixed(4);
    annualizedReturn = ((parseFloat(totalFeePct) / daysActive) * 365).toFixed(1);
  }

  if (uniFeesUSD > 0) {
    uniFeePct = ((uniFeesUSD / 50) * 100).toFixed(4);
  }

  return res.status(200).json({
    totalReturn: totalFeePct ? '+' + totalFeePct + '%' : null,
    annualizedReturn: annualizedReturn ? annualizedReturn + '%' : null,
    daysActive: Math.floor(daysActive),
    arbitrum: {
      inRange: uniInRange,
      feesUSD: uniFeesUSD.toFixed(6),
      feePct: uniFeePct ? '+' + uniFeePct + '%' : null,
      apy: uniAPY
    },
    solana: {
      inRange: orcaInRange,
      feesUSD: orcaFeesUSD.toFixed(6),
      feePct: orcaFeePct ? '+' + orcaFeePct + '%' : null,
      apy: orcaAPY,
      debug: { feeOwedA: null, feeOwedB: null }
    }
  });
}
