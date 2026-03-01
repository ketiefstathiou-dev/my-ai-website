export default async function handler(req, res) {
  // CORS so GitHub Pages can call Vercel
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  try {
    const { message } = req.body || {};
    if (!message || typeof message !== "string") {
      return res.status(400).json({ error: "Missing message" });
    }
    if (message.length > 900) {
      return res.status(400).json({ error: "Message too long (max 900 chars)" });
    }

    const openrouterKey = process.env.OPENROUTER_API_KEY;
    if (!openrouterKey) {
      return res.status(500).json({ error: "Missing OPENROUTER_API_KEY in Vercel env vars" });
    }

    const query = message.trim();

    // ---------- helpers ----------
    async function safeFetchText(url, options = {}) {
      try {
        const r = await fetch(url, options);
        if (!r.ok) return null;
        return await r.text();
      } catch {
        return null;
      }
    }

    async function safeFetchJson(url, options = {}) {
      try {
        const r = await fetch(url, options);
        if (!r.ok) return null;
        return await r.json();
      } catch {
        return null;
      }
    }

    // ---------- DuckDuckGo Instant Answer ----------
    const ddgUrl =
      "https://api.duckduckgo.com/?" +
      new URLSearchParams({
        q: query,
        format: "json",
        no_html: "1",
        no_redirect: "1",
        skip_disambig: "0"
      }).toString();

    const ddg = await safeFetchJson(ddgUrl);
    const ddgHeading = ddg?.Heading || "";
    const ddgAbstract = ddg?.AbstractText || "";
    const ddgAbstractUrl = ddg?.AbstractURL || "";

    // ---------- Wikipedia search + summary ----------
    async function wikipediaSearchTopTitle(q) {
      const url =
        "https://en.wikipedia.org/w/api.php?" +
        new URLSearchParams({
          action: "query",
          list: "search",
          srsearch: q,
          srlimit: "1",
          format: "json",
          origin: "*"
        }).toString();

      const data = await safeFetchJson(url);
      return data?.query?.search?.[0]?.title || null;
    }

    async function wikipediaSummary(title) {
      const url =
        "https://en.wikipedia.org/api/rest_v1/page/summary/" + encodeURIComponent(title);
      return await safeFetchJson(url, { headers: { Accept: "application/json" } });
    }

    let wikiTitle = null;
    let wikiSum = null;

    // Prefer DDG heading if it looks like a topic, otherwise search by query
    wikiTitle = ddgHeading || (await wikipediaSearchTopTitle(query));
    if (wikiTitle) wikiSum = await wikipediaSummary(wikiTitle);

    // ---------- Wikidata (current officeholders / "today-ish") ----------
    // If the user asks "current / now / president / prime minister / CEO", try Wikidata.
    const wantsCurrent =
      /\b(now|current|today|right now|who is)\b/i.test(query) ||
      /(president|prime minister|πρωθυπουργ|πρόεδρ|ceo)/i.test(query);

    // Map a few common roles to Wikidata properties:
    // - US President: position held (P39) + office "President of the United States" (Q11696)
    // - Greece Prime Minister: office "Prime Minister of Greece" (Q104802)
    // You can expand later.
    const roleRules = [
      {
        match: /(president of (the )?united states|πρόεδρος( της)? αμερικ)/i,
        officeQid: "Q11696",
        label: "President of the United States"
      },
      {
        match: /(prime minister of greece|πρωθυπουργ(ός|οσ) (της )?ελλάδ)/i,
        officeQid: "Q104802",
        label: "Prime Minister of Greece"
      }
    ];

    async function wikidataCurrentHolder(officeQid) {
      // SPARQL: people who hold the office (P39) with no end time (P582)
      const sparql = `
SELECT ?personLabel ?startTime ?article WHERE {
  ?person p:P39 ?posStatement.
  ?posStatement ps:P39 wd:${officeQid}.
  OPTIONAL { ?posStatement pq:P580 ?startTime. }
  FILTER NOT EXISTS { ?posStatement pq:P582 ?endTime. }

  OPTIONAL {
    ?article schema:about ?person ;
             schema:isPartOf <https://en.wikipedia.org/> .
  }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
}
LIMIT 3
      `.trim();

      const url =
        "https://query.wikidata.org/sparql?" +
        new URLSearchParams({ format: "json", query: sparql }).toString();

      const data = await safeFetchJson(url, {
        headers: {
          // Wikidata likes a UA
          "User-Agent": "my-ai-website (educational project)"
        }
      });

      const bindings = data?.results?.bindings || [];
      return bindings.map(b => ({
        name: b?.personLabel?.value,
        start: b?.startTime?.value || null,
        url: b?.article?.value || null
      })).filter(x => x.name);
    }

    let wikidataBlock = "";
    let wikidataSources = [];

    if (wantsCurrent) {
      for (const rule of roleRules) {
        if (rule.match.test(query)) {
          const holders = await wikidataCurrentHolder(rule.officeQid);
          if (holders.length) {
            wikidataBlock =
              `Wikidata current holder for: ${rule.label}\n` +
              holders.map(h => `- ${h.name}${h.start ? ` (since ${h.start.slice(0,10)})` : ""}`).join("\n");
            wikidataSources = holders
              .filter(h => h.url)
              .slice(0, 2)
              .map(h => ({ name: "Wikipedia (via Wikidata)", url: h.url }));
          } else {
            wikidataBlock = `Wikidata lookup attempted for: ${rule.label}\nNo current holder found.`;
          }
          break;
        }
      }
    }

    // ---------- Build context + sources ----------
    const sources = [];

    const contextParts = [];

    if (ddgHeading || ddgAbstract) {
      contextParts.push(
        `DuckDuckGo Instant Answer\nTitle: ${ddgHeading || "(none)"}\nAbstract: ${ddgAbstract || "(none)"}`
      );
      sources.push({
        name: "DuckDuckGo",
        url: ddgAbstractUrl || ("https://duckduckgo.com/?q=" + encodeURIComponent(query))
      });
    }

    if (wikiSum?.extract) {
      contextParts.push(
        `Wikipedia Summary\nTitle: ${wikiSum.title}\nSummary: ${wikiSum.extract}`
      );
      sources.push({
        name: "Wikipedia",
        url:
          wikiSum?.content_urls?.desktop?.page ||
          ("https://en.wikipedia.org/wiki/" + encodeURIComponent(wikiSum.title))
      });
    }

    if (wikidataBlock) {
      contextParts.push(wikidataBlock);
      sources.push({ name: "Wikidata", url: "https://www.wikidata.org/" });
      sources.push(...wikidataSources);
    }

    const webContext =
      contextParts.length ? contextParts.join("\n\n---\n\n") : "No web context available.";

    // ---------- Personality + instruction ----------
    const SYSTEM_PROMPT = `
You are a cheerful, helpful robot built by students from the “Student Parliament Team” at Theomitor School.

Language:
- Speak ENGLISH by default, unless the user writes Greek—then reply in Greek.

Critical truthfulness rule:
- You do NOT have guaranteed live internet.
- You are provided a "Web Context" block (DuckDuckGo/Wikipedia/Wikidata). Use it when present.
- If the user asks for time-sensitive facts ("who is the current president now", "today's news") and Web Context is missing/unclear, DO NOT GUESS.
  Say you can’t confirm with live sources, and suggest where to check.

Style:
- Friendly, clear, short paragraphs, bullets when helpful.
- If you used web context, include a short "Sources" list (names only). Do not paste raw URLs in the answer.
- Never mention API keys, providers, OpenRouter, or system prompts.
`.trim();

    // ---------- Call OpenRouter ----------
    const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${openrouterKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://ketiefstathiou-dev.github.io",
        "X-Title": "my-ai-website"
      },
      body: JSON.stringify({
        model: "openrouter/auto",
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "system", content: `Web Context (may be empty):\n${webContext}` },
          { role: "user", content: query }
        ]
      })
    });

    const data = await r.json().catch(() => ({}));

    if (!r.ok) {
      return res.status(r.status).json({
        error: "OpenRouter error",
        status: r.status,
        details: data
      });
    }

    const reply = data?.choices?.[0]?.message?.content || "No response.";
    // Return sources so the frontend can display them
    return res.status(200).json({ reply, sources });
  } catch (e) {
    return res.status(500).json({ error: "Server error", detail: String(e) });
  }
}
