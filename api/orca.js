export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const POSITION_ADDRESS = 'EwbJmn5yMhnTrTgJ3wqE2Bnt87wz8bBtg8gdbEwh6qrG';
  const HELIUS_KEY = '56f4b0e7-f504-4783-84cc-8ac64be0b054';
  const HELIUS_RPC = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}`;

  function readI32LE(buf, offset) {
    const v = buf[offset] | (buf[offset+1]<<8) | (buf[offset+2]<<16) | (buf[offset+3]<<24);
    return v > 0x7FFFFFFF ? v - 0x100000000 : v;
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

    // Show all i32 values from offset 64 onwards to find ticks
    const candidates = {};
    for (let i = 64; i <= 180; i += 4) {
      candidates[`offset_${i}`] = readI32LE(pos, i);
    }

    // Also show raw hex of bytes 64-180
    const hexChunk = pos.slice(64, 180).toString('hex');

    return res.status(200).json({
      totalBytes: pos.length,
      hexBytes64to180: hexChunk,
      i32candidates: candidates
    });
  } catch(err) {
    return res.status(200).json({ error: err.message });
  }
}
