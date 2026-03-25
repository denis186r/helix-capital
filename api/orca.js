export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const POSITION_ADDRESS = 'EwbJmn5yMhnTrTgJ3wqE2Bnt87wz8bBtg8gdbEwh6qrG';
  const POOL_ADDRESS = 'CsPc6gYMxnNJHo9JBRHBDeDwLniXbLxAHCLMHcPe4TiUk';
  const HELIUS_KEY = '56f4b0e7-f504-4783-84cc-8ac64be0b054';
  const HELIUS_RPC = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}`;

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
    return { result: json.result, error: json.error };
  }

  try {
    const posResp = await getAccountInfo(POSITION_ADDRESS);
    const poolResp = await getAccountInfo(POOL_ADDRESS);

    const posData = posResp.result?.value?.data?.[0];
    const posLen = posData ? Buffer.from(posData, 'base64').length : 0;
    const poolData = poolResp.result?.value?.data?.[0];
    const poolLen = poolData ? Buffer.from(poolData, 'base64').length : 0;

    return res.status(200).json({
      position: {
        error: posResp.error,
        exists: !!posResp.result?.value,
        dataLength: posLen,
        owner: posResp.result?.value?.owner,
        first32bytes: posData ? Buffer.from(posData, 'base64').slice(0,32).toString('hex') : null
      },
      pool: {
        error: poolResp.error,
        exists: !!poolResp.result?.value,
        dataLength: poolLen,
        owner: poolResp.result?.value?.owner,
        first32bytes: poolData ? Buffer.from(poolData, 'base64').slice(0,32).toString('hex') : null
      }
    });
  } catch(err) {
    return res.status(200).json({ error: err.message });
  }
}
