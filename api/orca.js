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

async function getLastSnapshotOrcaAPY() {
  try {
    const url = process.env.KV_REST_API_URL;
    const token = process.env.KV_REST_API_TOKEN;
    if (!url || !token) return null;
    const r1 = await fetch(`${url}/pipeline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify([['GET', 'snapshot:index']])
    });
    const j1 = await r1.json();
    const raw1 = j1[0]?.result;
    if (!raw1) return null;
    const p1 = JSON.parse(raw1);
    const index = typeof p1 === 'string' ? JSON.parse(p1) : p1;
    if (!Array.isArray(index) || index.length === 0) return null;
    const lastKey = index[index.length - 1];
    const r2 = await fetch(`${url}/pipeline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify([['GET', `snapshot:${lastKey}`]])
    });
    const j2 = await r2.json();
    const raw2 = j2[0]?.result;
    if (!raw2) return null;
    const p2 = JSON.parse(raw2);
    const snap = typeof p2 === 'string' ? JSON.parse(p2) : p2;
    const apy = snap?.apy?.orca;
    return (typeof apy === 'number' && apy > 0) ? apy : null;
  } catch(e) { return null; }
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
    const posAcc = await getAccount(POSITION_ADDRESS);
    if (!posAcc) throw new Error('Position not found');
    const pos = Buffer.from(posAcc.data[0], 'base64');

    const poolPubkey = base58Encode(pos.slice(8, 40));
    const posLiquidity = readU128LE(pos, 72);
    const tickLower    = readI32LE(pos, 88);
    const tickUpper    = readI32LE(pos, 92);

    const poolAcc = await getAccount(poolPubkey);
    if (!poolAcc) throw new Error('Pool not found');
    const pool = Buffer.from(poolAcc.data[0], 'base64');

    const sqrtPriceX64   = readU128LE(pool, 65);
    const currentTick    = readI32LE(pool, 81);
    const feeGrowthGlobalA = readU128LE(pool, 165);
    const feeGrowthGlobalB = readU128LE(pool, 245);

    const inRange = currentTick >= tickLower && currentTick <= tickUpper;

    // APY para mostrar en dashboard: leer del último snapshot (calculado por delta)
    const lastAPY = await getLastSnapshotOrcaAPY();
    const apyFinal = inRange ? String(lastAPY ?? APY_FALLBACK) : '0.0';
    const apyForFees = parseFloat(inRange ? (lastAPY ?? APY_FALLBACK) : 0);
    const feesPct = (carryover + apyForFees * daysActive / 365).toFixed(4);

    return res.status(200).json({
      inRange,
      apy: apyFinal,
      feesPct,
      tickLower, tickUpper, currentTick,
      poolAddress: poolPubkey,
      liquidity: posLiquidity.toString(),
      sqrtPriceX64: sqrtPriceX64.toString(),
      feeGrowthGlobalA: feeGrowthGlobalA.toString(),
      feeGrowthGlobalB: feeGrowthGlobalB.toString(),
      source: lastAPY ? 'snapshot-delta' : 'fallback',
    });

  } catch(err) {
    const feesPct = (carryover + APY_FALLBACK * daysActive / 365).toFixed(4);
    return res.status(200).json({
      inRange: true, apy: String(APY_FALLBACK), feesPct,
      source: 'fallback', error: err.message
    });
  }
}
