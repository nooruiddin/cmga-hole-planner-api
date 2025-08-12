// api/plan.js — Chat Completions + Structured Outputs (flag color mapping + fast greens default)

export default async function handler(req, res) {
  const allowed = new Set(["https://www.canadamga.ca","https://canadamga.ca"]);
  const origin = req.headers.origin || "";
  res.setHeader("Access-Control-Allow-Origin", allowed.has(origin) ? origin : "https://www.canadamga.ca");
  res.setHeader("Access-Control-Allow-Headers", "content-type");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST")  return res.status(405).send("Method Not Allowed");

  let body = req.body;
  if (!body || typeof body !== "object") { try { body = JSON.parse(req.body || "{}"); } catch { body = {}; } }

  if (body && body.ping) return res.status(200).json({ ok:true, version:"v2025-08-12-captain-flagcolor-fast10" });

  const {
    hole, par, notes, miss, handicap, wind,
    wind_strength, green_speed, captain_mode, pin_lr, pin_fb, flag_color
  } = body || {};

  const haveHole  = !(hole === undefined || hole === null || hole === "");
  const haveNotes = notes && Array.isArray(notes.safe) && Array.isArray(notes.avoid);

  // Map flag color -> depth if needed
  const mapFlag = (c)=>{
    const v = (c||"").toLowerCase();
    if (v === "red") return "F";
    if (v === "white") return "M";
    if (v === "blue") return "B";
    return null;
  };

  const effPinFB   = pin_fb || mapFlag(flag_color);
  const effGreen   = green_speed || "Fast (~10 stimp)"; // course provided info
  const effFlagTxt = flag_color ? `${flag_color} (${effPinFB === "F" ? "front" : effPinFB === "M" ? "middle" : effPinFB === "B" ? "back" : "unknown"})` : "—";

  if (process.env.MOCK === "1") {
    return res.status(200).json({
      conservative: "Fairway finder to center-green.",
      neutral: "Normal tee to widest side; two-putt target.",
      aggressive: "Only take on the tight line if the miss is safe.",
      club_suggestions: ["3-wood","Hybrid","Gap wedge"],
      warnings: haveNotes ? "" : "Generic guidance: client did not send hole notes."
    });
  }

  const safeArr  = haveNotes ? notes.safe  : ["Favor center line; play to the fat side."];
  const avoidArr = haveNotes ? notes.avoid : ["Don’t short-side; avoid water/front penalties."];

  const condLines = [
    `handicap: ${handicap ?? "unknown"}`,
    `miss: ${miss ?? "unknown"}`,
    `wind: ${wind ?? "calm/unknown"}`,
    `wind_strength: ${wind_strength ?? "—"}`,
    `green_speed: ${effGreen}`,
    (captain_mode && (pin_lr || effPinFB)) ? `pin_position: side=${pin_lr||"?"}, depth=${effPinFB||"?"} (flag=${effFlagTxt})` : null
  ].filter(Boolean).join("\n- ");

  const prompt = `
You are a cautious golf caddie. Use ONLY the provided notes for Shawneeki hole ${haveHole ? hole : "?"} (par ${par ?? "?"}).

Personalize a plan for:
- ${condLines}

SAFE:
- ${safeArr.join("\n- ")}
AVOID:
- ${avoidArr.join("\n- ")}

Course info to respect:
- Greens are running about 10 on the Stimpmeter (on the quicker side).
- Flag color indicates pin depth at this course: Red=Front, White=Middle, Blue=Back. If a color is provided, use that depth.

Guidance rules:
- Wind strength: Light = small yardage/aim tweaks; Moderate = club/aim adjustments; Strong = prioritize fairway/center green.
- Green speed: Fast (~10) = play below the hole and avoid short-siding; Slow = be more assertive with landing spots.
- Pin position: Favor the safe miss away from edges; reference L/C/R and F/M/B explicitly when helpful.
- Do not invent hazards or yardages not implied by the notes.
- Be concise and practical.

Output contract (must follow):
- Always return ALL keys: conservative, neutral, aggressive, club_suggestions, warnings.
- Use an empty array for "club_suggestions" if none.
- Use an empty string for "warnings" if none.
${haveNotes ? "" : "\n(Notes were missing; using generic safety notes.)"}
`.trim();

  if (!process.env.OPENAI_API_KEY) {
    return res.status(200).json({ error: "Missing OPENAI_API_KEY on server" });
  }

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
          required: ["conservative","neutral","aggressive","club_suggestions","warnings"]
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
