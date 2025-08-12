// api/plan.js — CMGA hole planner endpoint (Vercel Serverless Function)
// Uses OpenAI Responses API with text.format JSON schema (Aug 2025).

export default async function handler(req, res) {
  // --- CORS (allow www + bare domain) ---
  const allowed = new Set([
    "https://www.canadamga.ca",
    "https://canadamga.ca"
  ]);
  const origin = req.headers.origin || "";
  if (allowed.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  } else {
    // default to www (keeps it tight)
    res.setHeader("Access-Control-Allow-Origin", "https://www.canadamga.ca");
  }
  res.setHeader("Access-Control-Allow-Headers", "content-type");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST")  return res.status(405).send("Method Not Allowed");

  // --- Robust body parse (JSON or raw string) ---
  let body = req.body;
  if (!body || typeof body !== "object") {
    try { body = JSON.parse(req.body || "{}"); } catch { body = {}; }
  }

  const { hole, par, notes, miss, handicap, wind } = body || {};
  const haveHole  = !(hole === undefined || hole === null || hole === "");
  const haveNotes = notes && Array.isArray(notes.safe) && Array.isArray(notes.avoid);

  // Optional “mock mode” for quick sanity (set MOCK=1 in Vercel env)
  if (process.env.MOCK === "1") {
    return res.status(200).json({
      conservative: "Fairway finder to your number, center-green.",
      neutral: "Normal tee club to widest side; two-putt from the fat half.",
      aggressive: "Only take on the corner if the miss stays safe.",
      club_suggestions: ["3-wood","Hybrid","Gap wedge"],
      warnings: haveNotes ? "" : "Generic guidance: client did not send hole notes."
    });
  }

  // Fallback to generic notes if the client didn’t send any
  const safeArr  = haveNotes ? notes.safe  : ["Favor center line; play to the fat side."];
  const avoidArr = haveNotes ? notes.avoid : ["Don’t short-side; avoid water/front penalties."];

  const prompt = `
You are a cautious golf caddie. Use ONLY the provided notes for Shawneeki hole ${haveHole ? hole : "?"} (par ${par ?? "?"}).
Personalize a plan for:
- handicap: ${handicap ?? "unknown"}
- typical miss: ${miss ?? "unknown"}
- wind: ${wind ?? "calm/unknown"}

SAFE:
- ${safeArr.join("\n- ")}
AVOID:
- ${avoidArr.join("\n- ")}

Rules:
- Do not invent hazards or yardages beyond the notes.
- Be concise. If info is thin, say so and default conservative.
${haveNotes ? "" : "\n(Notes were missing from the client; these are generic safety notes.)"}
`.trim();

  if (!process.env.OPENAI_API_KEY) {
    // Return 200 with a clear error so the front-end can show it
    return res.status(200).json({ error: "Missing OPENAI_API_KEY on server" });
  }

  // --- Responses API with text.format JSON schema (replaces old response_format) ---
  const payload = {
    model: "gpt-4o-mini", // if you see “model not found”, change to "o4-mini"
    input: prompt,
    text: {
      format: {
        type: "json_schema",
        strict: true,
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            conservative:     { type: "string" },
            neutral:          { type: "string" },
            aggressive:       { type: "string" },
            club_suggestions: { type: "array", items: { type: "string" } },
            warnings:         { type: "string" }
          },
          required: ["conservative","neutral","aggressive"]
        }
      }
    }
  };

  try {
    const r = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    const txt = await r.text();
    // Don’t bubble 4xx/5xx to the browser; return a clear object
    if (!r.ok) {
      return res.status(200).json({
        openai_status: r.status,
        openai_error: txt.slice(0, 2000)
      });
    }

    // Extract text from Responses API
    let data;
    try { data = JSON.parse(txt); }
    catch { return res.status(200).json({ error: "OpenAI non-JSON", raw: txt.slice(0, 2000) }); }

    let outText = data.output_text;
    if (!outText && Array.isArray(data.output)) {
      try {
        outText = data.output
          .flatMap(o => Array.isArray(o.content) ? o.content : [])
          .map(c => (typeof c.text === "string" ? c.text : ""))
          .join("");
      } catch (_) {}
    }
    if (!outText || !outText.trim()) {
      return res.status(200).json({ error: "No text output from model", raw: JSON.stringify(data).slice(0, 2000) });
    }

    // The model returns JSON as text; parse to an object
    let out;
    try { out = JSON.parse(outText); }
    catch { return res.status(200).json({ error: "Model output invalid JSON", raw: outText.slice(0, 2000) }); }

    if (!haveNotes || !haveHole) {
      out.warnings = (out.warnings ? out.warnings + " " : "") +
                     "Generic guidance: request lacked full hole/notes.";
    }

    return res.status(200).json(out);
  } catch (e) {
    return res.status(200).json({ error: e?.message || "Server error calling OpenAI" });
  }
}
