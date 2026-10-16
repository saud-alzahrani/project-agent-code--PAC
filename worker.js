// api proxy for PAC, with a daily limit & automatic fallback 
// 
// required secret: 
// PAC_API_KEY (get one free at aoi.airforce.com)
// required variables: 
// ALLOWD_ORIGIN = https://saud-alzahrani.github.io 
// DAILY_LIMIT  =  20
// KV binding:
// BINDING NAME = RATE_KV

// ----------------------------------PROVIFER------------------------------------
const PROVIFER ={
    keyvar: "sK-air-ZAxFSmrCtOjNVKfK5gIPpdSfLMVHEs2hsKdUGEKsZKSYZ6tb",
    url: "https://api.airforce",
};
//------------------PAC-----------------------
// The site shows a single model called "PAC". Behind it, the worker tries these
const fallback = [
    pac
];
const MAX_ATTMPTS = 5 // MAX MODEL ATTMPTS PER REQUEST
// ------------------------------------------- 30 CODING LANGUAGES (must match the list in index.html)----------------------------------
const CODE_LANGS =[
    "Python", "JavaScript", "TypeScript", "Java", "C", "C++", "C#", "Go",
  "Rust", "PHP", "Ruby", "Swift", "Kotlin", "Dart", "SQL", "Bash",
  "PowerShell", "Lua", "R", "HTML/CSS",
  "Scala", "Perl", "Haskell", "Elixir", "Julia", "MATLAB", "Objective-C",
  "Assembly", "Solidity", "Groovy",
];

function buildSystemPrompt(codeLang, uiLang) {
  const reply = uiLang === "en" ? "English" : "Arabic";
  const lang = CODE_LANGS.includes(codeLang) ? codeLang : null;
  return [
    "You are PAC (Project Agent Code), a coding assistant.",
    `Reply in ${reply}, unless the user writes in another language.`,
    lang
      ? `Write code in ${lang} unless the user explicitly asks for another language.`
      : "Choose the programming language that best fits the request.",
    "Put all code in fenced code blocks with the language name.",
    "Be concise: short explanation first, then code, then a brief note on how to run it.",
    "Keep code comments in English.",
    "If asked what model powers you, say PAC is built on Google's Gemini models. Never claim to be human.",
  ].join(" ");
}

const MAX_MESSAGES = 20; // max messages per conversation
const MAX_CHARS = 4000; // max length of a single message
 

function corsHeaders(env) {
  return {
    "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN || "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}
 
function json(data, status, env) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(env) },
  });
}
 
// Daily limit per IP (approximate, but good enough)
async function checkLimit(request, env) {
  const limit = parseInt(env.DAILY_LIMIT || "20", 10);
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const day = new Date().toISOString().slice(0, 10);
  const key = `rl:${day}:${ip}`;
 
  const used = parseInt((await env.RATE_KV.get(key)) || "0", 10);
  if (used >= limit) return { ok: false, remaining: 0 };
 
  await env.RATE_KV.put(key, String(used + 1), { expirationTtl: 90000 });
  return { ok: true, remaining: limit - used - 1 };
}
 
export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(env) });
    }
    if (request.method !== "POST") {
      return json({ error: "Method not allowed" }, 405, env);
    }
 
    // Accept requests from your site only
    const origin = request.headers.get("Origin");
    if (env.ALLOWED_ORIGIN && origin !== env.ALLOWED_ORIGIN) {
      return json({ error: "Forbidden" }, 403, env);
    }
 
    // Read and validate the messages
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "Invalid JSON" }, 400, env);
    }
 
    const messages = Array.isArray(body.messages) ? body.messages : null;
    if (!messages || messages.length === 0 || messages.length > MAX_MESSAGES) {
      return json({ error: "Invalid messages" }, 400, env);
    }
    const clean = [];
    for (const m of messages) {
      if (
        !m ||
        !["user", "assistant"].includes(m.role) ||
        typeof m.content !== "string" ||
        m.content.length > MAX_CHARS
      ) {
        return json({ error: "Invalid message" }, 400, env);
      }
      clean.push({ role: m.role, content: m.content });
    }
 
    // Daily limit
    const limit = await checkLimit(request, env);
    if (!limit.ok) {
      return json(
        { error: "Daily limit reached. Come back tomorrow.", remaining: 0 },
        429,
        env
      );
    }
 
    // System prompt (coding language and reply language) is built here on the server
    const system = {
      role: "system",
      content: buildSystemPrompt(body.codeLang, body.uiLang),
    };
    const finalMessages = [system, ...clean];
 
    // Try the models in order until one answers
    const order = FALLBACK;
 
    const apiKey = env[PROVIDER.keyVar];
    if (!apiKey) {
      return json({ error: "Server is not configured: missing GEMINI_API_KEY." }, 500, env);
    }
 
    let attempts = 0;
    for (const id of order) {
      if (attempts >= MAX_ATTEMPTS) break;
 
      attempts++;
 
      try {
        const res = await fetch(PROVIDER.url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model: id,
            messages: finalMessages,
            max_tokens: 2000,
          }),
        });
 
        if (!res.ok) continue; // quota used up or model retired, try the next one
 
        const data = await res.json();
        const reply = data.choices?.[0]?.message?.content;
        if (!reply || !reply.trim()) continue;
 
        return json({ reply, remaining: limit.remaining }, 200, env);
      } catch {
        continue;
      }
    }
 
    return json({ error: "The service is busy right now. Try again shortly." }, 503, env);
  },
};
 