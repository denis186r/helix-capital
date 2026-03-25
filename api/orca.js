export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const POSITION_ADDRESS = 'EwbJmn5yMhnTrTgJ3wqE2Bnt87wz8bBtg8gdbEwh6qrG';
  const HELIUS_KEY = '56f4b0e7-f504-4783-84cc-8ac64be0b054';
  const HELIUS_RPC = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}`;

  const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

  function base58Encode(bytes) {
    let num = BigInt('0x' + Buffer.from(bytes).toString('hex'));
    let result = '';
    while (num > 0n) {
      result = BASE58_ALPHABET[Number(num % 58n)] + result;
      num = num / 58n;
    }
    for (const byte of bytes) {
      if (byte === 0) result = '1' + result;
      else break;
    }
    return result;
  }

  function readInt32LE(buf, offset) {
    const val = buf[offset] | (buf[offset+1]<<8) | (buf[offset+2]<<16) | (buf[offset+3]<<24);
    return val > 0x7FFFFFFF ? val - 0x100000000 : val;
  }

  function readUint128LE(buf, offset) {
    let result = 0n;
    for (let i = 0; i < 16; i++) result += BigInt(buf[offset+i]) << BigInt(i*8);
    return result;
  }

  async function getAccountInfo(pubkey) {
    const resp = await fetch(HELIUS_RPC, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1,
        method: 'getAccountInfo',
        params: [pubkey, { encoding: 'base64' }]
      })
    });
    const json = await resp.json();
    if (json.error) throw new Error(json.error.message);
    return json.result?.value;
  }

  try {
    const posAccount = await getAccountInfo(POSITION_ADDRESS);
    if (!posAccount) throw new Error('Position account not found');

    const posData = Buffer.from(posAccount.data[0], 'base64');

    // Extract pool address from position data
    // Layout: discriminator(8) + whirlpool_pubkey(32) + ...
    const poolPubkeyBytes = posData.slice(8, 40);
    const poolAddress = base58Encode(poolPubkeyBytes);

    // Read position data
    const liquidity = readUint128LE(posData, 72);
    const tickLower = readInt32LE(posData, 152);
    const tickUpper = readInt32LE(posData, 156);

    // Now fetch the pool with the correct address
    const poolAccount = await getAccountInfo(poolAddress);
    if (!poolAccount) throw new Error(`Pool not found: ${poolAddress}`);

    const poolData = Buffer.from(poolAccount.data[0], 'base64');
    const currentTick = readInt32LE(poolData, 116);
    const inRange = currentTick >= tickLower && currentTick <= tickUpper;

    // Get APY from DefiLlama
    let apy = null;
    try {
      const llamaRes = await fetch('https://yields.llama.fi/pools');
      const llamaData = await llamaRes.json();
      const pool = (llamaData.data || []).find(p =>
        p.chain === 'Solana' && p.project === 'orca' &&
        p.pool?.toLowerCase() === poolAddress.toLowerCase()
      );
      if (pool?.apy) apy = pool.apy.toFixed(1);
      else {
        const fallback = (llamaData.data || []).find(p =>
          p.chain === 'Solana' && p.project === 'orca' &&
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
      poolAddress,
      source: 'helius-rpc'
    });

  } catch(err) {
    return res.status(200).json({
      inRange: true, apy: null, feesPct: null,
      source: 'fallback', error: err.message
    });
  }
}
