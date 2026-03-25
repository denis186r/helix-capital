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

  try {
    const posAcc = await getAccount(POSITION_ADDRESS);
    const pos = Buffer.from(posAcc.data[0], 'base64');
    const poolPubkey = base58Encode(pos.slice(8, 40));
    const tickLower = readI32LE(pos, 88);
    const tickUpper = readI32LE(pos, 92);

    const poolAcc = await getAccount(poolPubkey);
    const pool = Buffer.from(poolAcc.data[0], 'base64');
    const currentTick = readI32LE(pool, 81);
    const inRange = currentTick >= tickLower && currentTick <= tickUpper;

    // Show all pool bytes as u64 candidates to find vault amounts
    const poolDebug = {};
    for (let i = 80; i <= 250; i += 8) {
      const val = readU64LE(pool, i);
      if (val > 0n && val < 1000000000000n) {
        poolDebug[`pool_u64_offset_${i}`] = val.toString();
      }
    }

    // Show pool hex 80-260
    poolDebug.poolHex80to260 = pool.slice(80, 260).toString('hex');
    poolDebug.poolTotalBytes = pool.length;

    return res.status(200).json({
      inRange, tickLower, tickUpper, currentTick,
      poolAddress: poolPubkey,
      poolDebug
    });

  } catch(err) {
    return res.status(200).json({ error: err.message });
  }
}
