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

function calcUniswapDeltaAPY(prev, curr, currentUni) {
  try {
    if (!prev?.feeGrowthGlobal0 || !curr?.feeGrowthGlobal0) return null;
    if (!currentUni?.liquidity || !currentUni?.sqrtPriceX96) return null;

    const Q128 = 2n ** 128n;
    const fg0_today = BigInt(curr.feeGrowthGlobal0);
    const fg1_today = BigInt(curr.feeGrowthGlobal1);
    const fg0_prev  = BigInt(prev.feeGrowthGlobal0);
    const fg1_prev  = BigInt(prev.feeGrowthGlobal1);

    const delta0 = fg0_today >= fg0_prev ? fg0_today - fg0_prev : Q128 - fg0_prev + fg0_today;
    const delta1 = fg1_today >= fg1_prev ? fg1_today - fg1_prev : Q128 - fg1_prev + fg1_today;

    const liquidity = BigInt(currentUni.liquidity);
    const fees_wBTC_raw = Number(delta0 * liquidity / Q128);
    const fees_WETH_raw = Number(delta1 * liquidity / Q128);
    if (fees_wBTC_raw < 0 || fees_WETH_raw < 0) return null;

    const sqrtPrice = Number(BigInt(currentUni.sqrtPriceX96)) / Math.pow(2, 96);
    const priceWETH_per_wBTC = (sqrtPrice * sqrtPrice) / 1e10;
    const fees_total_WETH = (fees_WETH_raw / 1e18) + (fees_wBTC_raw / 1e8) * priceWETH_per_wBTC;

    const sqL = Math.pow(1.0001, curr.tickLower / 2);
    const sqU = Math.pow(1.0001, curr.tickUpper / 2);
    const sqC = sqrtPrice;
    const L   = parseFloat(currentUni.liquidity);

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

    const apy = (fees_total_WETH / pos_WETH) * 365 * 100;
    if (apy < 1 || apy > 500) return null;
    return Math.round(apy * 10) / 10;
  } catch(e) { return null; }
}

function calcOrcaDeltaAPY(prev, curr, currentOrca) {
  try {
    if (!prev?.feeGrowthGlobalA || !curr?.feeGrowthGlobalA) return null;
    if (!currentOrca?.liquidity || !currentOrca?.sqrtPriceX64) return null;

    const Q64  = 2n ** 64n;
    const Q128 = 2n ** 128n;

    const fgA_today = BigInt(curr.feeGrowthGlobalA);
    const fgB_today = BigInt(curr.feeGrowthGlobalB);
    const fgA_prev  = BigInt(prev.feeGrowthGlobalA);
    const fgB_prev  = BigInt(prev.feeGrowthGlobalB);

    const deltaA = fgA_today >= fgA_prev ? fgA_today - fgA_prev : Q128 - fgA_prev + fgA_today;
    const deltaB = fgB_today >= fgB_prev ? fgB_today - fgB_prev : Q128 - fgB_prev + fgB_today;

    const liquidity = BigInt(currentOrca.liquidity);
    const feesA_raw = Number(deltaA * liquidity / Q64); // raw VCHF (9 dec)
    const feesB_raw = Number(deltaB * liquidity / Q64); // raw USDC (6 dec)
    if (feesA_raw < 0 || feesB_raw < 0) return null;

    const sqC = Number(BigInt(currentOrca.sqrtPriceX64)) / Number(Q64);
    const priceVCHF = sqC * sqC * 1000; // USDC per VCHF (ajuste decimales: 10^9/10^6=10^3)

    const feesUSD = (feesA_raw / 1e9) * priceVCHF + (feesB_raw / 1e6);

    const sqL = Math.pow(1.0001, curr.tickLowerOrca / 2);
    const sqU = Math.pow(1.0001, curr.tickUpperOrca / 2);
    const L   = Number(liquidity);

    let amtA_raw, amtB_raw;
    if (sqC <= sqL) {
      amtA_raw = L * (1/sqL - 1/sqU); amtB_raw = 0;
    } else if (sqC >= sqU) {
      amtA_raw = 0; amtB_raw = L * (sqU - sqL);
    } else {
      amtA_raw = L * (1/sqC - 1/sqU);
      amtB_raw = L * (sqC - sqL);
    }

    const posValueUSD = (amtA_raw / 1e9) * priceVCHF + (amtB_raw / 1e6);
    if (posValueUSD <= 0) return null;

    const apy = (feesUSD / posValueUSD) * 365 * 100;
    if (apy < 1 || apy > 500) return null;
    return Math.round(apy * 10) / 10;
  } catch(e) { return null; }
}

export default async function handler(req, res) {
  try {
    const { uniswap, orca } = await fetchPositionsData();
    const now       = new Date();
    const dayKey    = now.toISOString().slice(0, 10);
    const dayNumber = Math.floor((now - LAUNCH_DATE) / (1000 * 60 * 60 * 24)) + 1;

    const rawIndex = await kvGet("snapshot:index");
    let index = [];
    if (Array.isArray(rawIndex)) {
      index = rawIndex;
    } else if (typeof rawIndex === 'string') {
      const p = JSON.parse(rawIndex);
      index = Array.isArray(p) ? p : JSON.parse(p);
    }

    const sortedPast = index.filter(k => k < dayKey).sort();
    let prevSnap = null;
    if (sortedPast.length > 0) {
      prevSnap = parseSnap(await kvGet(`snapshot:${sortedPast[sortedPast.length - 1]}`));
    }

    const APY_UNI_DEFAULT  = 33;
    const APY_ORCA_DEFAULT = 30;
    const apyOrcaFromAPI   = parseFloat(orca?.apy ?? 0);

    // APY Uniswap: delta real o fallback 33
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

    // APY Orca: delta real o fallback 30
    let apyOrca = orca?.inRange ? apyOrcaFromAPI : 0;
    if (orca?.inRange && prevSnap && orca?.feeGrowthGlobalA) {
      const currOrcaData = {
        feeGrowthGlobalA: orca.feeGrowthGlobalA,
        feeGrowthGlobalB: orca.feeGrowthGlobalB,
        tickLowerOrca: orca.tickLower,
        tickUpperOrca: orca.tickUpper,
      };
      const prevOrcaData = {
        feeGrowthGlobalA: prevSnap.feeGrowthGlobalA,
        feeGrowthGlobalB: prevSnap.feeGrowthGlobalB,
        tickLowerOrca: prevSnap.tickLowerOrca,
        tickUpperOrca: prevSnap.tickUpperOrca,
      };
      const realOrcaAPY = calcOrcaDeltaAPY(prevOrcaData, currOrcaData, orca);
      if (realOrcaAPY !== null) apyOrca = realOrcaAPY;
      else if (orca?.inRange) apyOrca = APY_ORCA_DEFAULT; // fallback si delta falla
    }

    const apyWeighted = (apyUniswap + apyOrca) / 2;
    const prevReturn  = prevSnap?.returnPct ?? 0;
    const returnPct   = parseFloat((prevReturn + apyWeighted / 365).toFixed(4));

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
      // Uniswap fields
      feeGrowthGlobal0: uniswap?.feeGrowthGlobal0 ?? null,
      feeGrowthGlobal1: uniswap?.feeGrowthGlobal1 ?? null,
      tickLower: uniswap?.tickLower ?? null,
      tickUpper: uniswap?.tickUpper ?? null,
      // Orca fields (nuevos)
      feeGrowthGlobalA: orca?.feeGrowthGlobalA ?? null,
      feeGrowthGlobalB: orca?.feeGrowthGlobalB ?? null,
      tickLowerOrca: orca?.tickLower ?? null,
      tickUpperOrca: orca?.tickUpper ?? null,
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
