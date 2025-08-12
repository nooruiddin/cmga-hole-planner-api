export default async function handler(req, res) {
  // --- CORS (allow your Squarespace site) ---
  res.setHeader("Access-Control-Allow-Origin", "https://www.canadamga.ca");
  res.setHeader("Access-Control-Allow-Headers", "content-type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  try {
    const { hole, par, notes, miss, handicap, wind } = req.body || {};
    if (!hole || !notes || !Array.isArray(notes.safe) || !Array.isArray(notes.avoid)) {
      return res.status(400).json({ error: "Missing hole notes" });
    }

    const prompt = `
You are a cautious golf caddie. Use ONLY the provided notes for Shawneeki hole ${hole} (par ${par ?? "?"}).
Personalize a plan for:
- handicap: ${handicap ?? "unknown"}
- typical miss: ${miss ?? "unknown"}
- wind: ${wind ?? "calm/unknown"}

SAFE:
- ${(notes.safe || []).join("\n- ")}
AVOID:
- ${(notes.avoid || []).join("\n- ")}

Rules:
- Do not invent hazards or yardages not implied by the notes.
- Be concise. If info is thin, say so and default conservative.
`;

    const payload = {
      model: "gpt-4o-mini", // swap to "o4-mini" if needed
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

    const r = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    const txt = await r.text();
    if (!r.ok) return res.status(r.status).send(txt);

    let data;
    try { data = JSON.parse(txt); } catch { return res.status(502).json({ error: "OpenAI non-JSON", raw: txt }); }

    let outText = data.output_text;
    if (!outText && Array.isArray(data.output)) {
      outText = data.output.flatMap(o => (o.content || []).map(c => c.text || "")).join("");
    }
    if (!outText) return res.status(502).json({ error: "No text output from model", raw: data });

    try {
      const out = JSON.parse(outText);
      return res.status(200).json(out);
    } catch {
      return res.status(502).json({ error: "Model output invalid JSON", raw: outText });
    }
  } catch (e) {
    return res.status(500).json({ error: e?.message || "Server error" });
  }
}
