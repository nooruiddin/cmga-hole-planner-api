// api/plan.js
export default async function handler(req, res) {
  // --- CORS ---
  res.setHeader("Access-Control-Allow-Origin", "https://www.canadamga.ca");
  res.setHeader("Access-Control-Allow-Headers", "content-type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  // --- Robust body parse (handles JSON or string) ---
  let body = req.body;
  if (!body || typeof body !== "object") {
    try { body = JSON.parse(req.body || "{}"); } catch { body = {}; }
  }

  const { hole, par, notes, miss, handicap, wind } = body || {};
  if (!hole) return res.status(400).json({ error: "Missing 'hole' in request body" });

  const haveNotes = notes && Array.isArray(notes.safe) && Array.isArray(notes.avoid);
  const safeArr   = haveNotes ? notes.safe  : ["Favour center line; play to the fat side."];
  const avoidArr  = haveNotes ? notes.avoid : ["Don’t short-side; avoid penalties in front/edges."];

  const prompt = `
You are a cautious golf caddie. Use ONLY the provided notes for Shawneeki hole ${hole} (par ${par ?? "?"}).
Personalize a plan for:
- handicap: ${handicap ?? "unknown"}
- typical miss: ${miss ?? "unknown"}
- wind: ${wind ?? "calm/unknown"}

SAFE:
- ${safeArr.join("\n- ")}
AVOID:
- ${avoidArr.join("\n- ")}

Rules:
- Do not invent hazards or yardages not implied by the notes.
- Be concise. If info is thin, say so and default conservative.
${haveNotes ? "" : "\n(Notes were missing from the client; these are generic safety notes.)"}
`;

  const payload = {
    model: "o4-mini", // if you see "model not found", swap to "o4-mini"
    input: prompt,
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "hole_plan",
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            conservative: { type: "string" },
            neutral: { type: "string" },
            aggressive: { type: "string" },
            club_suggestions: { type: "array", items: { type: "string" } },
            warnings: { type: "string" }
          },
          required: ["conservative","neutral","aggressive"]
        },
        strict: true
      }
    }
  };

  // --- Call OpenAI ---
  const r = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  const txt = await r.text();
  if (!r.ok) return res.status(r.status).send(txt); // surface the real error body

  // --- Extract text from Responses API ---
  let data;
  try { data = JSON.parse(txt); }
  catch { return res.status(502).json({ error: "OpenAI non-JSON", raw: txt }); }

  let outText = data.output_text;
  if (!outText && Array.isArray(data.output)) {
    outText = data.output.flatMap(o => (o.content || []).map(c => c.text || "")).join("");
  }
  if (!outText) return res.status(502).json({ error: "No text output from model", raw: data });

  // --- Parse the model JSON and optionally add a warning ---
  let out;
  try { out = JSON.parse(outText); }
  catch { return res.status(502).json({ error: "Model output invalid JSON", raw: outText }); }

  if (!haveNotes) {
    out.warnings = (out.warnings ? out.warnings + " " : "") +
                   "Generic guidance: client did not send hole notes.";
  }

  return res.status(200).json(out);
}

