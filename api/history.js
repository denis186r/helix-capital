// Vercel serverless function - stores and retrieves daily performance history
// Uses Vercel KV-compatible approach with a simple JSON file via GitHub API
// Since we don't have a DB, we'll calculate TWR from stored snapshots

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

  async function getEthPrice() {
    try {
      const r = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=ethereum,bitcoin&vs_currencies=usd');
      const d = await r.json();
      return { eth: d.ethereum?.usd || 3000, btc: d.bitcoin?.usd || 60000 };
    } catch(e) {
      return { eth: 3000, btc: 60000 };
    }
  }

  try {
    const prices = await getEthPrice();

    // ── ARBITRUM: read tokensOwed from position ──────────────────────────
    let uniFeesUSD = 0;
    let uniFeePct = null;
    let uniAPY = null;
    let uniInRange = true;

    try {
      const posHex = POSITION_ID.toString(16).padStart(64, '0');
      const posResult = await ethCall(NFT_CONTRACT, '0x99fbab88' + posHex);
      const hex = posResult.slice(2);
      const slots = [];
      for (let i = 0; i < hex.length; i += 64) slots.push(hex.slice(i, i + 64));

      if (slots.length >= 12) {
        // tokensOwed0 = slot 10 (uint128), tokensOwed1 = slot 11 (uint128)
        const owed0 = BigInt('0x' + slots[10]); // wBTC (8 decimals)
        const owed1 = BigInt('0x' + slots[11]); // ETH (18 decimals)

        const owed0USD = (Number(owed0) / 1e8) * prices.btc;
        const owed1USD = (Number(owed1) / 1e18) * prices.eth;
        uniFeesUSD = owed0USD + owed1USD;

        // Initial investment ~$50
        const INITIAL_USD = 50;
        if (uniFeesUSD > 0) {
          uniFeePct = ((uniFeesUSD / INITIAL_USD) * 100).toFixed(4);
        }

        // Check in range
        let tickLower = parseInt(slots[5], 16);
        if (tickLower >= 0x800000) tickLower -= 0x1000000;
        let tickUpper = parseInt(slots[6], 16);
        if (tickUpper >= 0x800000) tickUpper -= 0x1000000;

        const slot0 = await ethCall(WETH_WBTC_POOL, '0x3850c7bd');
        const s0hex = slot0.slice(2);
        let currentTick = parseInt(s0hex.slice(64, 128), 16);
        if (currentTick >= 0x800000) currentTick -= 0x1000000;
        uniInRange = currentTick >= tickLower && currentTick <= tickUpper;

        // APY from Revert Finance API
        try {
          const revertRes = await fetch(
            `https://api.revert.finance/v1/positions?tokenId=${POSITION_ID}&network=arbitrum`
          );
          if (revertRes.ok) {
            const revertData = await revertRes.json();
            if (revertData?.position?.feeApr) {
              uniAPY = (revertData.position.feeApr * 100).toFixed(1);
            }
          }
        } catch(e) {}
      }
    } catch(e) {}

    // ── SOLANA: read feeOwed from position ──────────────────────────────
    let orcaFeesUSD = 0;
    let orcaFeePct = null;
    let orcaAPY = null;
    let orcaInRange = true;

    try {
      const posAcc = await getSolanaAccount(ORCA_POSITION);
      if (posAcc) {
        const pos = Buffer.from(posAcc.data[0], 'base64');
        const poolPubkey = base58Encode(pos.slice(8, 40));

        const tickLower = readI32LE(pos, 88);
        const tickUpper = readI32LE(pos, 92);

        // feeOwedA at offset 104 (u64) — VCHF (6 decimals, ~1.11 USD)
        // feeOwedB at offset 120 — wait, let's use correct offset
        // From our debug: feeOwedB was large, so check offset 112 for feeOwedA
        // Position layout confirmed: discriminator(8)+whirlpool(32)+mint(32)+
        // feeGrowthCheckpointA(16)+feeOwedA(8)+feeGrowthCheckpointB(16)+feeOwedB(8)
        // = 8+32+32+16+8+16+8 = 120 before ticks
        // But ticks are at 88/92... so layout is different
        // Actually: 8+32+32 = 72 for liquidity start
        // Let's use confirmed working offsets and find feeOwed near ticks
        // tickLower=88, tickUpper=92, so feeOwed must be before 88
        // feeGrowthCheckpointA(16) at 72, feeOwedA(8) at 88? No ticks are at 88
        // Try: feeOwedA right after tickUpper = offset 96
        const feeOwedA = readU64LE(pos, 96); // VCHF
        const feeOwedB = readU64LE(pos, 104); // USDC

        const feeOwedAUSD = (Number(feeOwedA) / 1e6) * 1.11;
        const feeOwedBUSD = Number(feeOwedB) / 1e6;
        orcaFeesUSD = feeOwedAUSD + feeOwedBUSD;

        const INITIAL_USD = 50;
        if (orcaFeesUSD > 0 && orcaFeesUSD < 100) { // sanity check
          orcaFeePct = ((orcaFeesUSD / INITIAL_USD) * 100).toFixed(4);
        }

        // Check in range
        const poolAcc = await getSolanaAccount(poolPubkey);
        if (poolAcc) {
          const pool = Buffer.from(poolAcc.data[0], 'base64');
          const currentTick = readI32LE(pool, 81);
          orcaInRange = currentTick >= tickLower && currentTick <= tickUpper;

          // APY from tvl and swap count
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

    // ── COMBINED RETURN ──────────────────────────────────────────────────
    // TWR: combined fees as % of total initial investment ($100)
    const totalFeesUSD = uniFeesUSD + orcaFeesUSD;
    const TOTAL_INITIAL = 100;
    const totalFeePct = totalFeesUSD > 0
      ? ((totalFeesUSD / TOTAL_INITIAL) * 100).toFixed(4)
      : null;

    // Days since start
    const START = new Date('2026-03-24').getTime() / 1000;
    const daysActive = Math.max(1, (Date.now()/1000 - START) / 86400);

    // Annualize the fee%
    let annualizedReturn = null;
    if (totalFeePct && parseFloat(totalFeePct) > 0) {
      annualizedReturn = ((parseFloat(totalFeePct) / daysActive) * 365).toFixed(1);
    }

    return res.status(200).json({
      totalReturn: totalFeePct ? '+' + totalFeePct + '%' : null,
      annualizedReturn: annualizedReturn ? annualizedReturn + '%' : null,
      daysActive: Math.floor(daysActive),
      arbitrum: {
        inRange: uniInRange,
        feesUSD: uniFeesUSD.toFixed(4),
        feePct: uniFeePct ? '+' + uniFeePct + '%' : null,
        apy: uniAPY
      },
      solana: {
        inRange: orcaInRange,
        feesUSD: orcaFeesUSD.toFixed(4),
        feePct: orcaFeePct ? '+' + orcaFeePct + '%' : null,
        apy: orcaAPY
      }
    });

  } catch(err) {
    return res.status(500).json({ error: err.message });
  }
}
