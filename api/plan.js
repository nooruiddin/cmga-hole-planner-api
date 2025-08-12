// api/plan.js — CMGA hole planner (Chat Completions + Structured Outputs)

export default async function handler(req, res) {
  const allowed = new Set(["https://www.canadamga.ca","https://canadamga.ca","https://www.canadamga.ca/shawneeki-golf-club"]);
  const origin = req.headers.origin || "";
  res.setHeader("Access-Control-Allow-Origin", allowed.has(origin) ? origin : "https://www.canadamga.ca");
  res.setHeader("Access-Control-Allow-Headers", "content-type");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST")  return res.status(405).send("Method Not Allowed");

  let body = req.body;
  if (!body || typeof body !== "object") { try { body = JSON.parse(req.body || "{}"); } catch { body = {}; } }

  // Ping to verify deploy
  if (body && body.ping) return res.status(200).json({ ok:true, version:"v2025-08-12-chat.completions-structured" });

  const { hole, par, notes, miss, handicap, wind } = body || {};
  const haveHole  = !(hole === undefined || hole === null || hole === "");
  const haveNotes = notes && Array.isArray(notes.safe) && Array.isArray(notes.avoid);

  if (process.env.MOCK === "1") {
    return res.status(200).json({
      conservative: "Fairway finder to center-green.",
      neutral: "Normal tee to widest side; take the two-putt.",
      aggressive: "Only take on the tight line if the miss is safe.",
      club_suggestions: ["3-wood","Hybrid","Gap wedge"],
      warnings: haveNotes ? "" : "Generic guidance: client did not send hole notes."
    });
  }

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
${haveNotes ? "" : "\n(Notes were missing; using generic safety notes.)"}
`.trim();

  if (!process.env.OPENAI_API_KEY) {
    return res.status(200).json({ error: "Missing OPENAI_API_KEY on server" });
  }

  // Chat Completions + Structured Outputs (no Responses API here)
  const payload = {
    model: "gpt-4o-mini", // if “model not found”, change to "o4-mini"
    messages: [{ role: "system", content: prompt }],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "hole_plan",
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
    },
    max_tokens: 400
  };

  try {
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    const txt = await r.text();
    if (!r.ok) return res.status(200).json({ openai_status: r.status, openai_error: txt.slice(0, 2000) });

    let data; try { data = JSON.parse(txt); } catch { return res.status(200).json({ error: "OpenAI non-JSON", raw: txt.slice(0,2000) }); }

    const content = data?.choices?.[0]?.message?.content || "";
    if (!content.trim()) return res.status(200).json({ error: "Empty completion" });

    let out; try { out = JSON.parse(content); } catch { return res.status(200).json({ error: "Model output invalid JSON", raw: content.slice(0,2000) }); }

    if (!haveNotes || !haveHole) {
      out.warnings = (out.warnings ? out.warnings + " " : "") + "Generic guidance: request lacked full hole/notes.";
    }
    return res.status(200).json(out);
  } catch (e) {
    return res.status(200).json({ error: e?.message || "Server error calling OpenAI" });
  }
}
