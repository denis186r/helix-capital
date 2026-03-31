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

function parseSnap(raw) {
  if (!raw) return null;
  if (typeof raw === 'object') return raw;
  const p1 = JSON.parse(raw);
  return typeof p1 === 'string' ? JSON.parse(p1) : p1;
}

async function fetchPositionsData() {
  const base = "https://helix-capital.vercel.app";
  const [uniRes, orcaRes] = await Promise.allSettled([
    fetch(`${base}/api/uniswap`).then(r => r.json()),
    fetch(`${base}/api/orca`).then(r => r.json()),
  ]);
  return {
    uniswap: uniRes.status === "fulfilled" ? uniRes.value : null,
    orca:    orcaRes.status === "fulfilled" ? orcaRes.value : null,
  };
}

// Compute real Uniswap APY from feeGrowthGlobal delta between two snapshots.
// Uses the simplified model: all position liquidity was active (no tick crossings).
// Uniswap V3 uses Q128 (feeGrowthGlobalX128), Orca uses Q64.
function calcUniswapDeltaAPY(prev, curr, currentUni) {
  try {
    if (!prev?.feeGrowthGlobal0 || !curr?.feeGrowthGlobal0) return null;
    if (!currentUni?.liquidity || !currentUni?.sqrtPriceX96) return null;

    const Q128 = 2n ** 128n;
    const fg0_today = BigInt(curr.feeGrowthGlobal0);
    const fg1_today = BigInt(curr.feeGrowthGlobal1);
    const fg0_prev  = BigInt(prev.feeGrowthGlobal0);
    const fg1_prev  = BigInt(prev.feeGrowthGlobal1);

    // Handle wraparound
    const delta0 = fg0_today >= fg0_prev ? fg0_today - fg0_prev : Q128 - fg0_prev + fg0_today;
    const delta1 = fg1_today >= fg1_prev ? fg1_today - fg1_prev : Q128 - fg1_prev + fg1_today;

    const liquidity = BigInt(currentUni.liquidity);

    // Fees earned in raw token units (wBTC=token0 8dec, WETH=token1 18dec)
    const fees_wBTC_raw = Number(delta0 * liquidity / Q128); // raw wBTC
    const fees_WETH_raw = Number(delta1 * liquidity / Q128); // raw WETH

    if (fees_wBTC_raw < 0 || fees_WETH_raw < 0) return null;

    // Price: sqrtPriceX96 = sqrt(WETH_raw / wBTC_raw) * 2^96
    // price_WETH_per_wBTC = (sqrtP/2^96)^2 → in raw units
    // price_human_WETH_per_wBTC = price_raw * (10^8 / 10^18) = price_raw / 10^10
    const sqrtPrice = Number(BigInt(currentUni.sqrtPriceX96)) / Math.pow(2, 96);
    const priceWETH_per_wBTC = (sqrtPrice * sqrtPrice) / 1e10;

    // Convert everything to WETH for ratio calculation
    const fees_wBTC_human = fees_wBTC_raw / 1e8;
    const fees_WETH_human = fees_WETH_raw / 1e18;
    const fees_total_WETH = fees_WETH_human + fees_wBTC_human * priceWETH_per_wBTC;

    // Position value in WETH using tick-based formula
    // token0=wBTC, token1=WETH; sqrtPrice in same float scale as tick-based sqrt
    const sqL = Math.pow(1.0001, curr.tickLower / 2);
    const sqU = Math.pow(1.0001, curr.tickUpper / 2);
    const sqC = sqrtPrice; // same scale after dividing both by 2^96... 
    // Note: sqL/sqU from ticks are "natural" sqrt prices, sqC is also natural sqrt price.
    // Both represent sqrt(price_raw), so they're comparable.
    const L = parseFloat(currentUni.liquidity);

    let amt_wBTC_raw, amt_WETH_raw;
    if (sqC <= sqL) {
      amt_wBTC_raw = L * (1/sqL - 1/sqU); amt_WETH_raw = 0;
    } else if (sqC >= sqU) {
      amt_wBTC_raw = 0; amt_WETH_raw = L * (sqU - sqL);
    } else {
      amt_wBTC_raw = L * (1/sqC - 1/sqU);
      amt_WETH_raw = L * (sqC - sqL);
    }

    const pos_WETH = (amt_WETH_raw / 1e18) + (amt_wBTC_raw / 1e8) * priceWETH_per_wBTC;
    if (pos_WETH <= 0) return null;

    // One-day delta → annualize
    const apy = (fees_total_WETH / pos_WETH) * 365 * 100;
    if (apy < 1 || apy > 500) return null;
    return Math.round(apy * 10) / 10;

  } catch(e) {
    return null;
  }
}

export default async function handler(req, res) {
  try {
    const { uniswap, orca } = await fetchPositionsData();
    const now    = new Date();
    const dayKey = now.toISOString().slice(0, 10);
    const dayNumber = Math.floor((now - LAUNCH_DATE) / (1000 * 60 * 60 * 24)) + 1;

    // --- Read index and previous snapshot ---
    const rawIndex = await kvGet("snapshot:index");
    let index = [];
    if (Array.isArray(rawIndex)) {
      index = rawIndex;
    } else if (typeof rawIndex === 'string') {
      const p = JSON.parse(rawIndex);
      index = Array.isArray(p) ? p : JSON.parse(p);
    }

    // Find most recent snapshot (excluding today)
    const sortedPast = index.filter(k => k < dayKey).sort();
    let prevSnap = null;
    if (sortedPast.length > 0) {
      prevSnap = parseSnap(await kvGet(`snapshot:${sortedPast[sortedPast.length - 1]}`));
    }

    // --- APY values ---
    const APY_UNI_DEFAULT = 33;
    const apyOrcaFromAPI  = parseFloat(orca?.apy ?? 0);

    // Try real Uniswap APY from feeGrowthGlobal delta
    let apyUniswap = APY_UNI_DEFAULT;
    if (prevSnap && uniswap?.feeGrowthGlobal0) {
      const currFGData = {
        feeGrowthGlobal0: uniswap.feeGrowthGlobal0,
        feeGrowthGlobal1: uniswap.feeGrowthGlobal1,
        tickLower: uniswap.tickLower,
        tickUpper: uniswap.tickUpper,
      };
      const prevFGData = {
        feeGrowthGlobal0: prevSnap.feeGrowthGlobal0,
        feeGrowthGlobal1: prevSnap.feeGrowthGlobal1,
      };
      const realAPY = calcUniswapDeltaAPY(prevFGData, currFGData, uniswap);
      if (realAPY !== null) apyUniswap = realAPY;
    }

    // Orca APY: use real value from API if in range, else 0
    const apyOrca = orca?.inRange ? apyOrcaFromAPI : 0;

    const apyWeighted = (apyUniswap + apyOrca) / 2;
    const returnPct   = parseFloat(((apyWeighted * dayNumber) / 365).toFixed(4));

    const snapshot = {
      date: dayKey,
      day:  dayNumber,
      apy: {
        uniswap:  apyUniswap,
        orca:     apyOrca,
        weighted: parseFloat(apyWeighted.toFixed(2)),
      },
      returnPct,
      inRangeUniswap: uniswap?.inRange ?? true,
      inRangeOrca:    orca?.inRange    ?? true,
      // Store feeGrowthGlobal for delta calculation tomorrow
      feeGrowthGlobal0: uniswap?.feeGrowthGlobal0 ?? null,
      feeGrowthGlobal1: uniswap?.feeGrowthGlobal1 ?? null,
      // Store tick bounds for position value calculation
      tickLower: uniswap?.tickLower ?? null,
      tickUpper: uniswap?.tickUpper ?? null,
      savedAt: now.toISOString(),
    };

    await kvSet(`snapshot:${dayKey}`, JSON.stringify(snapshot));

    if (!index.includes(dayKey)) {
      index.push(dayKey);
      index.sort();
      await kvSet("snapshot:index", JSON.stringify(index));
    }

    return res.status(200).json({ ok: true, saved: dayKey, snapshot });
  } catch(err) {
    console.error("[snapshot] Error:", err);
    return res.status(500).json({ error: err.message });
  }
}
