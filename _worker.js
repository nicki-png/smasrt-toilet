const ALLOWED_PINS = new Set(["V0","V1","V2","V3","V4","V5"]);

function corsHeaders(origin, env) {
  const allowed = env.ALLOWED_ORIGIN || "*";
  return {
    "Access-Control-Allow-Origin": allowed === "*" ? "*" : origin,
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400"
  };
}
function json(data, status=200, headers={}) {
  return new Response(JSON.stringify(data), {status, headers:{"Content-Type":"application/json; charset=utf-8", ...headers}});
}
function blynkBase(env) {
  return (env.BLYNK_BASE_URL || "https://blynk.cloud").replace(/\/+$/, "");
}
async function blynkGet(env, pin) {
  const url = `${blynkBase(env)}/external/api/get?token=${encodeURIComponent(env.BLYNK_AUTH_TOKEN)}&${pin}`;
  const r = await fetch(url);
  const body = await r.text();
  if (!r.ok) throw new Error(`Blynk read ${pin} failed (${r.status}): ${body.slice(0,180)}`);
  return body.trim();
}
async function blynkWrite(env, pin, value) {
  if (!ALLOWED_PINS.has(pin)) throw new Error("Pin not allowed");
  const url = `${blynkBase(env)}/external/api/update?token=${encodeURIComponent(env.BLYNK_AUTH_TOKEN)}&${pin}=${encodeURIComponent(value)}`;
  const r = await fetch(url, {method:"GET"});
  const body = await r.text();
  if (!r.ok || (body && !/^(ok|1|true)$/i.test(body.trim()))) {
    throw new Error(`Blynk write ${pin} failed (${r.status}): ${body.slice(0,180)}`);
  }
  return true;
}
async function connected(env) {
  const url = `${blynkBase(env)}/external/api/isHardwareConnected?token=${encodeURIComponent(env.BLYNK_AUTH_TOKEN)}`;
  const r = await fetch(url);
  if (!r.ok) return false;
  const body = (await r.text()).trim().toLowerCase();
  return body === "true" || body === "1";
}
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = corsHeaders(request.headers.get("Origin") || "", env);
    if (request.method === "OPTIONS") return new Response(null, {headers:cors});
    try {
      if (url.pathname === "/api/health") return json({ok:true, service:"automatic-toilet-worker"}, 200, cors);
      if (!env.BLYNK_AUTH_TOKEN) return json({ok:false,error:"BLYNK_AUTH_TOKEN secret is not configured."}, 500, cors);

      if (url.pathname === "/api/status" && request.method === "GET") {
        const [isOnline, v3, v4, v5, v0] = await Promise.all([
          connected(env),
          blynkGet(env,"V3"),
          blynkGet(env,"V4"),
          blynkGet(env,"V5"),
          blynkGet(env,"V0").catch(()=>null)
        ]);
        const parseNumber = (x) => {
          if (x === null || x === undefined) return null;
          const match = String(x).match(/-?\d+(\.\d+)?/);
          return match ? Number(match[0]) : null;
        };
        const parseString = (x) => {
          const s = String(x ?? "").trim();
          try { const j=JSON.parse(s); if(Array.isArray(j)) return String(j[0] ?? "UNKNOWN"); } catch {}
          return s.replace(/^["']|["']$/g,"") || "UNKNOWN";
        };
        return json({ok:true,connected:isOnline,occupancy:parseNumber(v3),remaining:parseNumber(v4),doorStatus:parseString(v5),payment:parseNumber(v0)},200,cors);
      }

      const routes = {
        "/api/payment": ["V0", 1],
        "/api/open": ["V1", 1],
        "/api/close": ["V2", 1]
      };
      if (request.method === "POST" && routes[url.pathname]) {
        const [pin,value] = routes[url.pathname];
        await blynkWrite(env,pin,value);
        // Push buttons are momentary; reset their virtual pin after a short pulse.
        // The ESP8266 callback receives the 1 event; reset is done asynchronously here.
        await new Promise(resolve => setTimeout(resolve, 350));
        await blynkWrite(env,pin,0);
        return json({ok:true,message:`${pin} command sent`},200,cors);
      }
      if (url.pathname.startsWith("/api/")) return json({ok:false,error:"Not found"},404,cors);
      return env.ASSETS.fetch(request);
    } catch (e) {
      return json({ok:false,error:e.message || "Unexpected server error"},502,cors);
    }
  }
};