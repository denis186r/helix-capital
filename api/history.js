/**
 * api/history.js
 * Devuelve la serie histórica completa desde Upstash Redis usando fetch (sin librerías).
 */

async function kvGet(key) {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  const res = await fetch(`${url}/get/${key}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json();
  return data.result ?? null;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=60");

  try {
    const rawIndex = await kvGet("snapshot:index");
    const index = Array.isArray(rawIndex) ? rawIndex : (rawIndex ? JSON.parse(rawIndex) : []);

    if (index.length === 0) {
      return res.status(200).json({ days: [], message: "No snapshots yet" });
    }

    const snapshots = await Promise.all(
      index.map(async (dateKey) => {
        const raw = await kvGet(`snapshot:${dateKey}`);
        if (!raw) return null;
        return typeof raw === 'object' ? raw : JSON.parse(raw);
      })
    );

    const days = snapshots.filter(Boolean).sort((a, b) => a.day - b.day);

    return res.status(200).json({ days, total: days.length });
  } catch (err) {
    console.error("[history] Error:", err);
    return res.status(500).json({ error: err.message });
  }
}
