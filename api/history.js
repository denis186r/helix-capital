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
    const v = buf[offset]|(buf[offset+1]<<8)|(buf[offset+2]<<16)|(buf[offset+3]<<24);
    return v > 0x7FFFFFFF ? v - 0x100000000 : v;
  }
  function readU64LE(buf, offset) {
    let r = 0n;
    for (let i = 0; i < 8; i++) r += BigInt(buf[offset+i]) << BigInt(i*8);
    return r;
  }
  async function ethCall(to, data) {
    const r = await fetch(ARBITRUM_RPC, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({jsonrpc:'2.0',method:'eth_call',params:[{to,data},'latest'],id:1})
    });
    return (await r.json()).result;
  }
  async function getSolanaAccount(pubkey) {
    const r = await fetch(HELIUS_RPC, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({jsonrpc:'2.0',id:1,method:'getAccountInfo',params:[pubkey,{encoding:'base64'}]})
    });
    return (await r.json()).result?.value;
  }

  const START = new Date('2026-03-24').getTime()/1000;
  const daysActive = Math.max(1, (Date.now()/1000 - START) / 86400);

  // ── ARBITRUM APY: try Revert Finance first ──────────────────────────
  let uniAPY = null, uniInRange = true;

  try {
    // Try Revert Finance API
    const revertUrls = [
      `https://api.revert.finance/v1/positions?tokenId=${POSITION_ID}&network=arbitrum`,
      `https://api.revert.finance/v1/uniswapv3/positions/${POSITION_ID}?network=arbitrum`,
      `https://api.revert.finance/v1/position/${POSITION_ID}?network=arbitrum&protocol=uniswapv3`,
    ];

    for (const url of revertUrls) {
      try {
        const r = await fetch(url, {
          headers: { 'Accept': 'application/json', 'Origin': 'https://revert.finance' }
        });
        if (r.ok) {
          const d = await r.json();
          // Try different response shapes
          const apr = d?.position?.feeApr || d?.feeApr || d?.apr ||
                      d?.position?.apr || d?.data?.feeApr ||
                      d?.position?.fee_apr || d?.fee_apr;
          if (apr) {
            uniAPY = (parseFloat(apr) * 100).toFixed(1);
            break;
          }
          // Try if APY is already in percentage
          const apyPct = d?.position?.feeApyPercent || d?.position?.feeAprPercent ||
                         d?.feeAprPercent || d?.apyPercent;
          if (apyPct) {
            uniAPY = parseFloat(apyPct).toFixed(1);
            break;
          }
        }
      } catch(e) {}
    }
  } catch(e) {}

  // Fallback to DefiLlama
  if (!uniAPY) {
    try {
      const r = await fetch('https://yields.llama.fi/pools');
      const d = await r.json();
      const pool = (d.data||[]).find(p =>
        p.chain==='Arbitrum' && p.project==='uniswap-v3' &&
        p.pool?.toLowerCase() === WETH_WBTC_POOL.toLowerCase()
      );
      if (pool?.apy) uniAPY = pool.apy.toFixed(1);
      else {
        const fb = (d.data||[]).find(p =>
          p.chain==='Arbitrum' && p.project==='uniswap-v3' &&
          p.symbol?.includes('WBTC') && p.symbol?.includes('ETH') && p.apy > 0
        );
        if (fb?.apy) uniAPY = fb.apy.toFixed(1);
      }
    } catch(e) {}
  }
  if (!uniAPY) uniAPY = '14.3';

  // Check in range
  try {
    const posHex = POSITION_ID.toString(16).padStart(64,'0');
    const result = await ethCall(NFT_CONTRACT, '0x99fbab88' + posHex);
    const slots = [];
    for (let i = 2; i < result.length; i += 64) slots.push(result.slice(i, i+64));
    let tl = parseInt(slots[5],16); if (tl>=0x800000) tl-=0x1000000;
    let tu = parseInt(slots[6],16); if (tu>=0x800000) tu-=0x1000000;
    const s0 = await ethCall(WETH_WBTC_POOL, '0x3850c7bd');
    let ct = parseInt(s0.slice(2+64, 2+128),16); if (ct>=0x800000) ct-=0x1000000;
    uniInRange = ct >= tl && ct <= tu;
  } catch(e) {}

  // ── SOLANA APY ───────────────────────────────────────────────────────
  let orcaAPY = null, orcaInRange = true;

  try {
    const posAcc = await getSolanaAccount(ORCA_POSITION);
    if (posAcc) {
      const pos = Buffer.from(posAcc.data[0], 'base64');
      const poolPubkey = base58Encode(pos.slice(8,40));
      const tickLower = readI32LE(pos, 88);
      const tickUpper = readI32LE(pos, 92);

      const poolAcc = await getSolanaAccount(poolPubkey);
      if (poolAcc) {
        const pool = Buffer.from(poolAcc.data[0], 'base64');
        const currentTick = readI32LE(pool, 81);
        orcaInRange = currentTick >= tickLower && currentTick <= tickUpper;
        const tvlRaw = readU64LE(pool, 168);
        const tvlUSD = Number(tvlRaw)/1e6;
        const sigsRes = await fetch(HELIUS_RPC, {
          method:'POST', headers:{'Content-Type':'application/json'},
          body: JSON.stringify({jsonrpc:'2.0',id:1,method:'getSignaturesForAddress',params:[poolPubkey,{limit:100}]})
        });
        const sigs = ((await sigsRes.json()).result||[]);
        const now = Date.now()/1000;
        const swaps24h = sigs.filter(s=>s.blockTime&&s.blockTime>now-86400).length;
        const feeRate = (pool[45]|(pool[46]<<8))/1000000;
        const dailyFees = swaps24h*1000*feeRate;
        if (tvlUSD>0&&dailyFees>0) orcaAPY = ((dailyFees/tvlUSD)*365*100).toFixed(1);
      }
    }
  } catch(e) {}
  if (!orcaAPY) orcaAPY = '19.0';

  // ── PROJECTED RETURN ─────────────────────────────────────────────────
  const uniApyNum = parseFloat(uniAPY);
  const orcaApyNum = parseFloat(orcaAPY);
  const weightedAPY = (uniApyNum * 0.5) + (orcaApyNum * 0.5);
  const projectedReturn = ((weightedAPY * daysActive) / 365).toFixed(4);
  const uniProjected = ((uniApyNum * daysActive) / 365).toFixed(4);
  const orcaProjected = ((orcaApyNum * daysActive) / 365).toFixed(4);

  return res.status(200).json({
    totalReturn: '+' + projectedReturn + '%',
    annualizedReturn: weightedAPY.toFixed(1) + '%',
    daysActive: Math.floor(daysActive),
    mode: 'projected',
    arbitrum: { inRange:uniInRange, feePct:'+'+uniProjected+'%', apy:uniAPY },
    solana: { inRange:orcaInRange, feePct:'+'+orcaProjected+'%', apy:orcaAPY }
  });
}
