export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { value, secret } = req.query;
  const EXPECTED = process.env.CARRYOVER_SECRET || 'helix2026';

  if (secret !== EXPECTED) return res.status(401).json({ error: 'No autorizado' });

  const num = parseFloat(value);
  if (isNaN(num) || num < 0) return res.status(400).json({ error: 'Valor inválido' });

  const url   = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return res.status(500).json({ error: 'Redis no configurado' });

  try {
    await fetch(`${url}/pipeline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify([['SET', 'orca_fees_carryover', JSON.stringify(num)]])
    });
    return res.status(200).json({
      ok: true,
      carryover_guardado: num,
      siguiente_paso: 'Actualiza POSITION_ADDRESS y OPEN_TIMESTAMP en orca.js'
    });
  } catch(err) {
    return res.status(500).json({ error: err.message });
  }
}
