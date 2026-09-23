// ============================================================================
// ウォークアプリ用 中継 Cloudflare Worker
//
// ブラウザから直接つなげない相手（APIキーが必要、CORSが通らない、キーを隠したい）
// への中継だけを行う。プロンプトや問い合わせ文はすべてこのコードで固定し、
// 任意の内容を外部APIへ素通しする窓口は作らない。
//
// 使うアプリ: ルート下見ウォーカー / 寄り道ウォーカー / 次どこウォーカー
//
// 入口一覧（詳しくは worker/README.md）
//   GET  /?u=<maps.app.goo.gl のURL>  短縮リンクの展開      → {"url":"https://www.google.com/maps?..."}
//   GET  /route?engine=...&coords=... 経路計算の中継（BRouter / OSRM）
//   POST /key      {code}             合言葉 → Google Maps APIキー
//   POST /guide    {code,context,events} AI道案内（Claude Haiku）
//   POST /overpass （Overpassのクエリ本文）  スポット検索の中継
//   POST /jev      {code,stage,...}   行き先・道順の順位づけ（TypeSafe Jev）
//
// Cloudflare の「設定 → 変数とシークレット」に、次を「シークレット」で登録する
// （コードには書かない。使わない機能のものは未登録でよく、その入口だけが止まる）
//   ACCESS_CODES      名前:合言葉 をカンマ区切り。例) self:長いランダム文字列,friends:別の長いランダム文字列
//                     人ごと・グループごとに分けておけば、1つだけ消して無効化できる
//   MAPS_API_KEY      Google Maps のAPIキー          （/key で使う）
//   ANTHROPIC_API_KEY Claude APIのキー               （/guide で使う）
//   TYPESAFE_API_KEY  TypeSafe Jev APIのキー         （/jev で使う）
// ============================================================================

// 自分のGitHub Pagesのドメイン。POSTの入口はここからの呼び出しだけを受け付ける
const ALLOWED_ORIGIN = "https://koikeyap.github.io";

const LIMITS = {
  guideBody: 12000,      // リクエスト本文の上限（バイト数ではなく文字数）
  overpassBody: 60000,
  jevBody: 30000,
  guideEvents: 12,       // 1回に案内文を作るスポットの数
  guideTextLen: 120,     // 案内文1件の長さ
  jevCandidates: 10,     // 1回に比べる候補の数
  jevWishLen: 200,       // 自由記入の長さ
  codeMinLen: 8,         // 合言葉の最短の長さ
  redirectHops: 5,       // 短縮リンクをたどる回数
};

// ---------------------------------------------------------------------------
// 共通の小道具
// ---------------------------------------------------------------------------
const corsHeaders = {
  "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Vary": "Origin",
};
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

// 外部APIの応答をそのまま返す（中身は解釈しない）
const passThrough = async (res, contentType) =>
  new Response(await res.text(), {
    status: res.status,
    headers: { ...corsHeaders, "Content-Type": contentType || res.headers.get("Content-Type") || "application/json" },
  });

// 文字列を一定時間で比較（一致するまでの時間差で合言葉を推測されにくくする）
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
function codeOk(env, code) {
  const codes = String(env.ACCESS_CODES || "")
    .split(",").map(s => s.trim()).filter(Boolean)
    .map(s => { const i = s.indexOf(":"); return i >= 0 ? s.slice(i + 1) : s; });
  return code.length >= LIMITS.codeMinLen && codes.some(c => safeEqual(c, code));
}

// POSTの入口で共通して行う確認。問題があれば返す Response を、なければ null を返す
function checkPost(request, maxLen, raw) {
  if (request.method !== "POST") return json({ error: "method not allowed" }, 405);
  if (request.headers.get("Origin") !== ALLOWED_ORIGIN) return json({ error: "forbidden" }, 403);
  if (raw !== undefined && raw.length > maxLen) return json({ error: "too large" }, 413);
  return null;
}
// 合言葉つきのJSON本文を読む。{ error: Response } か { body } を返す
async function readAuthedJson(request, env, maxLen) {
  const pre = checkPost(request, maxLen);
  if (pre) return { error: pre };
  const raw = await request.text();
  if (raw.length > maxLen) return { error: json({ error: "too large" }, 413) };
  let body;
  try { body = JSON.parse(raw); } catch (e) { return { error: json({ error: "bad json" }, 400) }; }
  if (!codeOk(env, String(body.code || ""))) {
    await new Promise(r => setTimeout(r, 1000));   // 総当たりを遅くする
    return { error: json({ error: "invalid code" }, 401) };
  }
  return { body };
}
// 外部APIに渡す値を整える（範囲外・欠損はnullにする。nullは「不明」を意味する）
function num(v, lo, hi) {
  if (v === null || v === undefined || v === "") return null;
  v = Number(v);
  if (!isFinite(v)) return null;
  return Math.min(hi, Math.max(lo, Math.round(v * 100) / 100));
}
const str = (v, n) => String(v == null ? "" : v).slice(0, n);
const list = (v, n, f) => (Array.isArray(v) ? v : []).slice(0, n).map(f);

// ---------------------------------------------------------------------------
// /guide : AI道案内（寄り道ウォーカー）
// ---------------------------------------------------------------------------
const GUIDE_MODEL = "claude-haiku-4-5-20251001";
const GUIDE_SYSTEM = `あなたは長距離ウォーキングの音声ガイドです。入力JSONの events それぞれについて、歩いている人に読み上げる日本語の案内文を1つずつ作ります。
ルール:
- 入力に書かれた事実だけを使う。営業時間・歴史・評判・混雑など、入力にない情報は絶対に書かない。
- 1件につき1〜2文、全角60字以内。耳で聞いて分かる、落ち着いた話し言葉にする。
- 距離は「約◯メートル先」のように丸める。side が「右」「左」なら「右手」「左手」、「沿道」なら「道沿い」と言う。
- name が null のスポットは種類だけを言う。
- 出力は次のJSONだけ。前置きやコードブロックは付けない: {"items":[{"id":"<入力のid>","text":"<案内文>"}]}`;

async function handleGuide(request, env) {
  const { error, body } = await readAuthedJson(request, env, LIMITS.guideBody);
  if (error) return error;
  if (!env.ANTHROPIC_API_KEY) return json({ error: "ai not configured" }, 500);

  const events = Array.isArray(body.events) ? body.events.slice(0, LIMITS.guideEvents) : [];
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
  let items;
  try { items = JSON.parse(text).items || []; } catch (e) { return json({ error: "bad model output" }, 502); }

  // 渡したスポットに対応する案内文だけを返す（モデルが増やした分は捨てる）
  const ids = new Set(events.map(e => e.id));
  items = items
    .filter(it => it && ids.has(it.id) && typeof it.text === "string")
    .map(it => ({ id: it.id, text: it.text.slice(0, LIMITS.guideTextLen) }));
  return json({ items, usage: data.usage || null });
}

// ---------------------------------------------------------------------------
// /jev : 行き先・道順の順位づけ（次どこウォーカー）
// ---------------------------------------------------------------------------
const JEV_MODEL = "jev-latest";
const JEV_PREFS = {
  dest: {
    green: "Wants to end at a park, garden, or other green space.",
    worship: "Wants to end at a shrine, temple, or historic site.",
    view: "Wants to end at a viewpoint or hilltop with a good view.",
    water: "Wants to end by the water (pond, lake, river, or beach).",
    culture: "Wants to end at a museum, gallery, zoo, aquarium, or tourist attraction.",
    station: "Wants to end near a train station so that going home is easy.",
  },
  route: {
    supply: "Wants frequent chances to buy drinks or use a toilet (convenience stores, toilets, drinking water).",
    quiet: "Prefers quiet streets and footpaths over busy main roads.",
    flat: "Wants to avoid climbing; prefers a small total ascent.",
    sights: "Wants many sights along the way (shrines, temples, viewpoints, historic places, museums).",
  },
};
const JEV_TYPES = {
  station: "train station", park: "park or garden", worship: "shrine or temple", view: "viewpoint",
  museum: "museum or similar facility", sight: "tourist attraction", peak: "summit", historic: "historic site",
  water: "waterside place", point: "unnamed point", home: "home", custom: "place chosen by the walker",
  konbini: "convenience store", toilet: "toilet", cafe: "cafe",
};
const JEV_COMPASS = ["north", "northeast", "east", "southeast", "south", "southwest", "west", "northwest"];
const JEV_INSTRUCTIONS = {
  dest:
    "The walker is deciding where the next leg of a leisurely city walk should end. " +
    "Pick the candidate destination the walker would most like to walk to. " +
    "Follow `walker_request` (free text, may be Japanese) and `destination_preferences` first. " +
    "Judge each candidate by its name, `destination.type`, and `nearby_places`. " +
    "Distances are approximate and were already filtered to be close to `target_distance_km`. " +
    "Prefer candidates with low `overlap_with_already_walked_share`. Place names are in Japanese.",
  route:
    "The destination of the next leg is already chosen. Pick the candidate route to it that best fits the walker. " +
    "Follow `walker_request` (free text, may be Japanese) and `route_preferences` first. " +
    "Also prefer a `distance_km` close to `target_distance_km` when it is given, and a low `overlap_with_already_walked_share`. " +
    "A null value means the information is unknown, not zero. Place names are in Japanese.",
};
const jevPlace = s => ({ name: str(s && s.name, 40), type: JEV_TYPES[s && s.type] || "place" });

// 候補の組み立て。段階ごとに、Jevに見せる項目と選択肢の文言を決める
const JEV_STAGES = {
  dest: {
    prefsKey: "destination_preferences",
    candidate(c, i) {
      const b = num(c.bearing, 0, 360);
      return {
        id: "c" + (i + 1),
        destination: jevPlace(c),
        approx_distance_km: num(c.km, 0, 80),
        direction: b == null ? null : JEV_COMPASS[Math.round(b / 45) % 8],
        nearby_places: list(c.nearby, 6, jevPlace),
        overlap_with_already_walked_share: num(c.overlap, 0, 1),
      };
    },
    criterion: c => `End at ${c.destination.name} (${c.destination.type})`,
  },
  route: {
    prefsKey: "route_preferences",
    candidate: (c, i) => ({
      id: "c" + (i + 1),
      route_label: str(c.label, 30),
      distance_km: num(c.km, 0, 80),
      ascent_m: num(c.ascent, 0, 5000),
      convenience_stores: num(c.konbini, 0, 300),
      toilets: num(c.toilets, 0, 300),
      drinking_water: num(c.water, 0, 300),
      cafes: num(c.cafes, 0, 300),
      longest_stretch_without_store_or_toilet_km: num(c.maxGapKm, 0, 80),
      sights_along_the_way: list(c.sights, 8, jevPlace),
      main_road_share: num(c.busy, 0, 1),
      quiet_path_share: num(c.quiet, 0, 1),
      unpaved_share: num(c.unpaved, 0, 1),
      overlap_with_already_walked_share: num(c.overlap, 0, 1),
    }),
    criterion: c => `Take route ${c.id} (${c.route_label}, ${c.distance_km} km)`,
  },
};

async function handleJev(request, env) {
  const { error, body } = await readAuthedJson(request, env, LIMITS.jevBody);
  if (error) return error;
  if (!env.TYPESAFE_API_KEY) return json({ error: "jev not configured" }, 500);

  const stage = body.stage === "route" ? "route" : "dest";
  const spec = JEV_STAGES[stage];
  const input = Array.isArray(body.candidates) ? body.candidates.slice(0, LIMITS.jevCandidates) : [];
  if (input.length < 2) return json({ error: "need 2+ candidates" }, 400);

  const cands = input.map(spec.candidate);
  const criteria = {};
  for (const c of cands) criteria[c.id] = spec.criterion(c);

  const prefsMap = JEV_PREFS[stage];
  const prefs = (Array.isArray(body.prefs) ? body.prefs : []).filter(k => prefsMap[k]).map(k => prefsMap[k]);
  const state = {
    target_distance_km: num(body.target_km, 0.5, 50),
    walker_request: str(body.wish, LIMITS.jevWishLen).trim() || null,
    [spec.prefsKey]: prefs.length ? prefs : ["No special preference; a pleasant, varied stroll."],
    candidates: cands,
  };
  if (stage === "route") state.destination = str(input[0] && input[0].name, 40);

  const r = await fetch("https://api.typesafe.ai/v1/systemone", {
    method: "POST",
    headers: { "Authorization": `Bearer ${env.TYPESAFE_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: JEV_MODEL,
      state,
      questions: { best: { type: "choice", instructions: JEV_INSTRUCTIONS[stage], criteria } },
    }),
  });
  if (!r.ok) return json({ error: "upstream", status: r.status, detail: (await r.text()).slice(0, 200) }, 502);

  const data = await r.json();
  const a = data.answers && data.answers.best;
  if (!a || a.type !== "choice" || !a.probabilities) return json({ error: "bad model output" }, 502);

  // アプリ側の並び順（0始まり）に戻して返す
  const probabilities = {};
  cands.forEach((c, i) => { probabilities[i] = Number(a.probabilities[c.id]) || 0; });
  return json({
    stage, model: data.model,
    choice: cands.findIndex(c => c.id === a.choice),
    confidence: a.confidence, probabilities, usage: data.usage || null,
  });
}

// ---------------------------------------------------------------------------
// /overpass : スポット検索の中継（ブラウザから直接つながらない場合用）
// ---------------------------------------------------------------------------
async function handleOverpass(request) {
  const pre = checkPost(request, LIMITS.overpassBody);
  if (pre) return pre;
  const raw = await request.text();
  if (raw.length > LIMITS.overpassBody) return json({ error: "too large" }, 413);
  const r = await fetch("https://overpass-api.de/api/interpreter", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "yorimichi-walker (personal, low volume)" },
    body: raw,
  });
  return passThrough(r, "application/json");
}

// ---------------------------------------------------------------------------
// /key : 合言葉 → Google Maps APIキー
// ---------------------------------------------------------------------------
async function handleKey(request, env) {
  const { error } = await readAuthedJson(request, env, 1000);
  if (error) return error;
  if (!env.MAPS_API_KEY) return json({ error: "key not configured" }, 500);
  return json({ key: env.MAPS_API_KEY });
}

// ---------------------------------------------------------------------------
// /route : 経路計算の中継（行き先はBRouterとOSRMに固定）
// ---------------------------------------------------------------------------
const COORDS_RE = /^-?\d{1,3}(\.\d+)?,-?\d{1,2}(\.\d+)?(;-?\d{1,3}(\.\d+)?,-?\d{1,2}(\.\d+)?){1,49}$/;
const BROUTER_PROFILES = ["hiking-mountain", "shortest", "trekking"];
const BROUTER_ALTS = ["0", "1", "2", "3"];

async function handleRoute(request, sp) {
  const coords = sp.get("coords") || "";
  if (!COORDS_RE.test(coords)) return json({ error: "bad coords" }, 400);

  let upstream;
  const engine = sp.get("engine");
  if (engine === "osrm") {
    upstream = `https://routing.openstreetmap.de/routed-foot/route/v1/driving/${coords}?overview=full&geometries=geojson&continue_straight=false`;
  } else if (engine === "brouter") {
    // プロファイルと代替案番号は決まった値だけ受け付ける
    const profile = BROUTER_PROFILES.includes(sp.get("profile")) ? sp.get("profile") : BROUTER_PROFILES[0];
    const alt = BROUTER_ALTS.includes(sp.get("alt")) ? sp.get("alt") : "0";
    upstream = `https://brouter.de/brouter?lonlats=${coords.replaceAll(";", "|")}&profile=${profile}&alternativeidx=${alt}&format=geojson`;
  } else {
    return json({ error: "unknown engine" }, 400);
  }
  const r = await fetch(upstream, { headers: { "User-Agent": "route-preview-walker (personal, low volume)" } });
  return passThrough(r);
}

// ---------------------------------------------------------------------------
// / : 短縮リンクの展開（Googleの短縮リンクだけ）
// ---------------------------------------------------------------------------
const SHORTLINK_RE = /^https:\/\/(maps\.app\.goo\.gl|goo\.gl)\/[A-Za-z0-9_\-\/?=&]+$/;

async function handleShortlink(sp) {
  const target = sp.get("u") || "";
  if (!SHORTLINK_RE.test(target)) return json({ error: "unsupported url" }, 400);
  let current = target;
  for (let i = 0; i < LIMITS.redirectHops; i++) {
    const res = await fetch(current, { redirect: "manual" });
    const loc = res.headers.get("Location");
    if (!loc) break;
    current = new URL(loc, current).toString();
    if (!/(^|\.)goo\.gl$/.test(new URL(current).hostname)) break;   // goo.glの外に出たら終わり
  }
  return json({ url: current });
}

// ---------------------------------------------------------------------------
// 振り分け
// ---------------------------------------------------------------------------
const ROUTES = {
  "/guide": (request, env) => handleGuide(request, env),
  "/jev": (request, env) => handleJev(request, env),
  "/overpass": (request) => handleOverpass(request),
  "/key": (request, env) => handleKey(request, env),
  "/route": (request, env, sp) => handleRoute(request, sp),
  "/": (request, env, sp) => handleShortlink(sp),
};

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
    const url = new URL(request.url);
    const handler = ROUTES[url.pathname];
    if (!handler) return json({ error: "not found" }, 404);
    try {
      return await handler(request, env, url.searchParams);
    } catch (e) {
      return json({ error: "worker error", detail: String(e && e.message || e).slice(0, 200) }, 500);
    }
  },
};
