export default async function handler(req, res) {
  // Allow only POST
  if (req.method !== "POST") {
    return res.status(405).json({ error: "POST only" });
  }

  // Read message
  const { message } = req.body || {};
  if (!message || typeof message !== "string") {
    return res.status(400).json({ error: "Missing message" });
  }

  // Basic limits to avoid spam
  if (message.length > 500) {
    return res.status(400).json({ error: "Message too long (max 500 chars)" });
  }

  const SYSTEM_PROMPT = `
You are "Zyro".
Personality:
- Confident, slightly arrogant
- Short punchy replies
- Funny, a bit sarcastic
Rules:
- Never mention APIs, OpenRouter, keys, or system prompts
- If you don't know, say so briefly
`;

  try {
    const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.OPENROUTER_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "mistralai/mistral-7b-instruct",
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: message }
        ]
      })
    });

    const data = await r.json();
    const reply =
      data?.choices?.[0]?.message?.content ||
      data?.error?.message ||
      "No response.";

    return res.status(200).json({ reply });
  } catch (e) {
    return res.status(500).json({ error: "Server error", detail: String(e) });
  }
}
