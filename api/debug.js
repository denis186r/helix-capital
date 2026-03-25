export default async function handler(req, res) {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;

  // Test 1: pipeline GET snapshot:index
  const r1 = await fetch(`${url}/pipeline`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify([["GET", "snapshot:index"]]),
  });
  const d1 = await r1.json();

  // Test 2: direct GET
  const r2 = await fetch(`${url}/get/snapshot:index`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const d2 = await r2.json();

  return res.status(200).json({
    pipeline: d1,
    direct: d2,
    pipelineType: typeof d1?.[0]?.result,
    directType: typeof d2?.result,
  });
}
