// ルート下見ウォーカー / 寄り道ウォーカー用 中継 Cloudflare Worker
//   1) 短縮リンクの展開:  GET  /?u=<maps.app.goo.gl のURL>     → {"url":"https://www.google.com/maps?..."}
//   2) 経路計算の中継:    GET  /route?engine=brouter|osrm&coords=経度,緯度;経度,緯度;...[&profile=hiking-mountain|shortest|trekking&alt=0-3]
//   3) 合言葉でAPIキー:   POST /key  {"code":"合言葉"}           → {"key":"AIza..."}
//   4) AI道案内:          POST /guide {"code","context","events"} → {"items":[{"id","text"}]}  （Claude Haiku）
//   5) スポット検索の中継: POST /overpass  （Overpass API への中継。ブラウザから直接つながらない場合用）
//
// Cloudflare の「設定 → 変数とシークレット」に次の2つを「シークレット」として登録する（コードには書かない）
//   MAPS_API_KEY  : Google Maps の APIキー
//   ANTHROPIC_API_KEY : Claude API のキー（AI道案内を使う場合のみ）
//   TYPESAFE_API_KEY : Jev API のキー
//   ACCESS_CODES  : 名前:合言葉 をカンマ区切り。例) self:長いランダム文字列,friends:別の長いランダム文字列
//                   人ごと・グループごとに分けておけば、1つだけ消して無効化できる
//
// ALLOWED_ORIGIN を自分の GitHub Pages のドメインにしておくと、他のサイトからは使えなくなる
const ALLOWED_ORIGIN = "https://koikeyap.github.io";

const COORDS_RE = /^-?\d{1,3}(\.\d+)?,-?\d{1,2}(\.\d+)?(;-?\d{1,3}(\.\d+)?,-?\d{1,2}(\.\d+)?){1,49}$/;

// 文字列を一定時間で比較（一致するまでの時間差で合言葉を推測されにくくする）
const GUIDE_MODEL = "claude-haiku-4-5-20251001";
const GUIDE_SYSTEM = `あなたは長距離ウォーキングの音声ガイドです。入力JSONの events それぞれについて、歩いている人に読み上げる日本語の案内文を1つずつ作ります。
ルール:
- 入力に書かれた事実だけを使う。営業時間・歴史・評判・混雑など、入力にない情報は絶対に書かない。
- 1件につき1〜2文、全角60字以内。耳で聞いて分かる、落ち着いた話し言葉にする。
- 距離は「約◯メートル先」のように丸める。side が「右」「左」なら「右手」「左手」、「沿道」なら「道沿い」と言う。
- name が null のスポットは種類だけを言う。
- 出力は次のJSONだけ。前置きやコードブロックは付けない: {"items":[{"id":"<入力のid>","text":"<案内文>"}]}`;

const JEV_MODEL = "jev-latest";
const JEV_DEST_PREFS = {
  green: "Wants to end at a park, garden, or other green space.",
  worship: "Wants to end at a shrine, temple, or historic site.",
  view: "Wants to end at a viewpoint or hilltop with a good view.",
  water: "Wants to end by the water (pond, lake, river, or beach).",
  culture: "Wants to end at a museum, gallery, zoo, aquarium, or tourist attraction.",
  station: "Wants to end near a train station so that going home is easy.",
};
const JEV_ROUTE_PREFS = {
  supply: "Wants frequent chances to buy drinks or use a toilet (convenience stores, toilets, drinking water).",
  quiet: "Prefers quiet streets and footpaths over busy main roads.",
  flat: "Wants to avoid climbing; prefers a small total ascent.",
  sights: "Wants many sights along the way (shrines, temples, viewpoints, historic places, museums).",
};
const JEV_TYPES = {
  station: "train station", park: "park or garden", worship: "shrine or temple", view: "viewpoint", museum: "museum or similar facility",
  sight: "tourist attraction", peak: "summit", historic: "historic site", water: "waterside place", point: "unnamed point",
  home: "home", custom: "place chosen by the walker",
  konbini: "convenience store", toilet: "toilet", cafe: "cafe",
};
const JEV_COMPASS = ["north", "northeast", "east", "southeast", "south", "southwest", "west", "northwest"];
const JEV_DEST_INSTRUCTIONS =
  "The walker is deciding where the next leg of a leisurely city walk should end. " +
  "Pick the candidate destination the walker would most like to walk to. " +
  "Follow `walker_request` (free text, may be Japanese) and `destination_preferences` first. " +
  "Judge each candidate by its name, `destination.type`, and `nearby_places`. " +
  "Distances are approximate and were already filtered to be close to `target_distance_km`. " +
  "Prefer candidates with low `overlap_with_already_walked_share`. Place names are in Japanese.";
const JEV_ROUTE_INSTRUCTIONS =
  "The destination of the next leg is already chosen. Pick the candidate route to it that best fits the walker. " +
  "Follow `walker_request` (free text, may be Japanese) and `route_preferences` first. " +
  "Also prefer a `distance_km` close to `target_distance_km` when it is given, and a low `overlap_with_already_walked_share`. " +
  "A null value means the information is unknown, not zero. Place names are in Japanese.";
function jevNum(v, lo, hi) { if (v === null || v === undefined || v === "") return null; v = Number(v); if (!isFinite(v)) return null; return Math.min(hi, Math.max(lo, Math.round(v * 100) / 100)); }
function jevStr(v, n) { return String(v == null ? "" : v).slice(0, n); }
function jevList(v, n, f) { return (Array.isArray(v) ? v : []).slice(0, n).map(f); }


function codeOk(env, code) {
  const codes = String(env.ACCESS_CODES || "")
    .split(",").map(s => s.trim()).filter(Boolean)
    .map(s => { const i = s.indexOf(":"); return i >= 0 ? s.slice(i + 1) : s; });
  return code.length >= 8 && codes.some(c => safeEqual(c, code));
}

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

export default {
  async fetch(request, env) {
    const cors = {
      "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Vary": "Origin",
    };
    const json = (obj, status = 200) =>
      new Response(JSON.stringify(obj), { status, headers: { ...cors, "Content-Type": "application/json" } });
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });

    const url = new URL(request.url);
    const sp = url.searchParams;

    // ---- 4) AI道案内（プロンプトはここで固定。任意の質問を中継する窓口にしない） ----
    if (url.pathname === "/guide") {
      if (request.method !== "POST") return json({ error: "method not allowed" }, 405);
      if (request.headers.get("Origin") !== ALLOWED_ORIGIN) return json({ error: "forbidden" }, 403);
      const raw = await request.text();
      if (raw.length > 12000) return json({ error: "too large" }, 413);
      let body; try { body = JSON.parse(raw); } catch (e) { return json({ error: "bad json" }, 400); }
      if (!codeOk(env, String(body.code || ""))) { await new Promise(r => setTimeout(r, 1000)); return json({ error: "invalid code" }, 401); }
      if (!env.ANTHROPIC_API_KEY) return json({ error: "ai not configured" }, 500);
      const events = Array.isArray(body.events) ? body.events.slice(0, 12) : [];
      if (!events.length) return json({ items: [] });
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify({
          model: GUIDE_MODEL, max_tokens: 900, system: GUIDE_SYSTEM,
          messages: [{ role: "user", content: JSON.stringify({ context: body.context || {}, events }) }],
        }),
      });
      if (!r.ok) return json({ error: "upstream", status: r.status, detail: (await r.text()).slice(0, 200) }, 502);
      const data = await r.json();
      const text = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("").replace(/```json|```/g, "").trim();
      let items = [];
      try { items = JSON.parse(text).items || []; } catch (e) { return json({ error: "bad model output" }, 502); }
      const ids = new Set(events.map(e => e.id));
      items = items.filter(it => it && ids.has(it.id) && typeof it.text === "string").map(it => ({ id: it.id, text: it.text.slice(0, 120) }));
      return json({ items, usage: data.usage || null });
    }

    // ---- 5) Overpass API の中継 ----
    if (url.pathname === "/overpass") {
      if (request.method !== "POST") return json({ error: "method not allowed" }, 405);
      if (request.headers.get("Origin") !== ALLOWED_ORIGIN) return json({ error: "forbidden" }, 403);
      const raw = await request.text();
      if (raw.length > 60000) return json({ error: "too large" }, 413);
      const r = await fetch("https://overpass-api.de/api/interpreter", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "yorimichi-walker (personal, low volume)" },
        body: raw,
      });
      return new Response(await r.text(), { status: r.status, headers: { ...cors, "Content-Type": "application/json" } });
    }
    
    // ---- 6) 行き先・道順の順位づけ（TypeSafe Jev）。質問文はここで固定し、任意の質問を中継する窓口にしない ----
    if (url.pathname === "/jev") {
      if (request.method !== "POST") return json({ error: "method not allowed" }, 405);
      if (request.headers.get("Origin") !== ALLOWED_ORIGIN) return json({ error: "forbidden" }, 403);
      const raw = await request.text();
      if (raw.length > 30000) return json({ error: "too large" }, 413);
      let body; try { body = JSON.parse(raw); } catch (e) { return json({ error: "bad json" }, 400); }
      if (!codeOk(env, String(body.code || ""))) { await new Promise(r => setTimeout(r, 1000)); return json({ error: "invalid code" }, 401); }
      if (!env.TYPESAFE_API_KEY) return json({ error: "jev not configured" }, 500);
      const stage = body.stage === "route" ? "route" : "dest";
      const list = Array.isArray(body.candidates) ? body.candidates.slice(0, 10) : [];
      if (list.length < 2) return json({ error: "need 2+ candidates" }, 400);
      const place = s => ({ name: jevStr(s && s.name, 40), type: JEV_TYPES[s && s.type] || "place" });
      let cands, prefsMap, instructions, prefsKey, criteria = {};
      if (stage === "dest") {
        prefsMap = JEV_DEST_PREFS; instructions = JEV_DEST_INSTRUCTIONS; prefsKey = "destination_preferences";
        cands = list.map((c, i) => {
          const b = jevNum(c.bearing, 0, 360);
          return {
            id: "c" + (i + 1),
            destination: place(c),
            approx_distance_km: jevNum(c.km, 0, 80),
            direction: b == null ? null : JEV_COMPASS[Math.round(b / 45) % 8],
            nearby_places: jevList(c.nearby, 6, place),
            overlap_with_already_walked_share: jevNum(c.overlap, 0, 1),
          };
        });
        for (const c of cands) criteria[c.id] = `End at ${c.destination.name} (${c.destination.type})`;
      } else {
        prefsMap = JEV_ROUTE_PREFS; instructions = JEV_ROUTE_INSTRUCTIONS; prefsKey = "route_preferences";
        cands = list.map((c, i) => ({
          id: "c" + (i + 1),
          route_label: jevStr(c.label, 30),
          distance_km: jevNum(c.km, 0, 80),
          ascent_m: jevNum(c.ascent, 0, 5000),
          convenience_stores: jevNum(c.konbini, 0, 300),
          toilets: jevNum(c.toilets, 0, 300),
          drinking_water: jevNum(c.water, 0, 300),
          cafes: jevNum(c.cafes, 0, 300),
          longest_stretch_without_store_or_toilet_km: jevNum(c.maxGapKm, 0, 80),
          sights_along_the_way: jevList(c.sights, 8, place),
          main_road_share: jevNum(c.busy, 0, 1),
          quiet_path_share: jevNum(c.quiet, 0, 1),
          unpaved_share: jevNum(c.unpaved, 0, 1),
          overlap_with_already_walked_share: jevNum(c.overlap, 0, 1),
        }));
        for (const c of cands) criteria[c.id] = `Take route ${c.id} (${c.route_label}, ${c.distance_km} km)`;
      }
      const prefs = (Array.isArray(body.prefs) ? body.prefs : []).filter(k => prefsMap[k]).map(k => prefsMap[k]);
      const reqText = jevStr(body.wish, 200).trim();
      const jevState = {
        target_distance_km: jevNum(body.target_km, 0.5, 50),
        walker_request: reqText || null,
        [prefsKey]: prefs.length ? prefs : ["No special preference; a pleasant, varied stroll."],
        candidates: cands,
      };
      if (stage === "route") jevState.destination = jevStr(list[0] && list[0].name, 40);
      const r = await fetch("https://api.typesafe.ai/v1/systemone", {
        method: "POST",
        headers: { "Authorization": `Bearer ${env.TYPESAFE_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: JEV_MODEL, state: jevState, questions: { best: { type: "choice", instructions, criteria } } }),
      });
      if (!r.ok) return json({ error: "upstream", status: r.status, detail: (await r.text()).slice(0, 200) }, 502);
      const data = await r.json();
      const a = data.answers && data.answers.best;
      if (!a || a.type !== "choice" || !a.probabilities) return json({ error: "bad model output" }, 502);
      const probabilities = {};
      cands.forEach((c, i) => { probabilities[i] = Number(a.probabilities[c.id]) || 0; });
      return json({ stage, model: data.model, choice: cands.findIndex(c => c.id === a.choice), confidence: a.confidence, probabilities, usage: data.usage || null });
    }

    // ---- 3) 合言葉 → APIキー ----
    if (url.pathname === "/key") {
      if (request.method !== "POST") return json({ error: "method not allowed" }, 405);
      if (request.headers.get("Origin") !== ALLOWED_ORIGIN) return json({ error: "forbidden" }, 403);
      let code = "";
      try { code = String((await request.json()).code || ""); } catch (e) {}
      if (!codeOk(env, code)) {
        await new Promise(r => setTimeout(r, 1000)); // 総当たりを遅くする
        return json({ error: "invalid code" }, 401);
      }
      if (!env.MAPS_API_KEY) return json({ error: "key not configured" }, 500);
      return json({ key: env.MAPS_API_KEY });
    }

    // ---- 2) 経路計算の中継（行き先は下の2つに固定） ----
    if (url.pathname === "/route") {
      const coords = sp.get("coords") || "";
      if (!COORDS_RE.test(coords)) return json({ error: "bad coords" }, 400);
      let upstream;
      if (sp.get("engine") === "osrm") {
        upstream = `https://routing.openstreetmap.de/routed-foot/route/v1/driving/${coords}?overview=full&geometries=geojson&continue_straight=false`;
      } else if (sp.get("engine") === "brouter") {
        // プロファイルと代替案番号は決まった値だけ受け付ける
        const profile = ["hiking-mountain", "shortest", "trekking"].includes(sp.get("profile")) ? sp.get("profile") : "hiking-mountain";
        const alt = ["0", "1", "2", "3"].includes(sp.get("alt")) ? sp.get("alt") : "0";
        upstream = `https://brouter.de/brouter?lonlats=${coords.replaceAll(";", "|")}&profile=${profile}&alternativeidx=${alt}&format=geojson`;
      } else {
        return json({ error: "unknown engine" }, 400);
      }
      const r = await fetch(upstream, { headers: { "User-Agent": "route-preview-walker (personal, low volume)" } });
      return new Response(await r.text(), {
        status: r.status,
        headers: { ...cors, "Content-Type": r.headers.get("Content-Type") || "application/json" },
      });
    }

    // ---- 1) 短縮リンクの展開（Google の短縮リンクだけ） ----
    const target = sp.get("u") || "";
    if (!/^https:\/\/(maps\.app\.goo\.gl|goo\.gl)\/[A-Za-z0-9_\-\/?=&]+$/.test(target)) {
      return json({ error: "unsupported url" }, 400);
    }
    let current = target;
    for (let i = 0; i < 5; i++) {
      const res = await fetch(current, { redirect: "manual" });
      const loc = res.headers.get("Location");
      if (!loc) break;
      current = new URL(loc, current).toString();
      if (!/(^|\.)goo\.gl$/.test(new URL(current).hostname)) break;
    }
    return json({ url: current });
  },
};
