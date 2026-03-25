/**
 * api/snapshot.js
 * Guarda un snapshot diario en Upstash Redis usando fetch (sin librerías).
 * Cron: 23:50 UTC cada día (vercel.json)
 * Manual: GET /api/snapshot
 */

const LAUNCH_DATE = new Date("2026-03-24T00:00:00Z");

async function kvGet(key) {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  const res = await fetch(`${url}/pipeline`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify([["GET", key]]),
  });
  const data = await res.json();
  return data[0]?.result ?? null;
}

async function kvSet(key, value) {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  await fetch(`${url}/pipeline`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify([["SET", key, value]]),
  });
}

async function fetchPositionsData() {
  const base = "https://helix-capital.vercel.app";
  const [uniRes, orcaRes] = await Promise.allSettled([
    fetch(`${base}/api/uniswap`).then((r) => r.json()),
    fetch(`${base}/api/orca`).then((r) => r.json()),
  ]);
  return {
    uniswap: uniRes.status === "fulfilled" ? uniRes.value : null,
    orca: orcaRes.status === "fulfilled" ? orcaRes.value : null,
  };
}

export default async function handler(req, res) {
  try {
    const { uniswap, orca } = await fetchPositionsData();

    const now = new Date();
    const dayKey = now.toISOString().slice(0, 10);
    const dayNumber = Math.floor((now - LAUNCH_DATE) / (1000 * 60 * 60 * 24)) + 1;

    const apyUniswap = 33;
    const apyOrca = orca?.apy ?? 19;
    const apyWeighted = apyUniswap * 0.5 + apyOrca * 0.5;
    const returnPct = parseFloat(((apyWeighted * dayNumber) / 365).toFixed(4));

    const snapshot = {
      date: dayKey,
      day: dayNumber,
      apy: {
        uniswap: apyUniswap,
        orca: apyOrca,
        weighted: parseFloat(apyWeighted.toFixed(2)),
      },
      returnPct,
      status: {
        uniswap: uniswap?.inRange ?? true,
        orca: orca?.inRange ?? true,
      },
      savedAt: now.toISOString(),
    };

    // Guardar snapshot del día
    await kvSet(`snapshot:${dayKey}`, JSON.stringify(snapshot));

    // Actualizar índice de fechas
    const rawIndex = await kvGet("snapshot:index");
    const index = rawIndex ? JSON.parse(rawIndex) : [];
    if (!index.includes(dayKey)) {
      index.push(dayKey);
      index.sort();
      await kvSet("snapshot:index", JSON.stringify(index));
    }

    return res.status(200).json({ ok: true, saved: dayKey, snapshot });
  } catch (err) {
    console.error("[snapshot] Error:", err);
    return res.status(500).json({ error: err.message });
  }
}
