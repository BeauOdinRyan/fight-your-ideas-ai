// Prompt Brawl AI helper.
//
// The Roblox game sends a player's prompt (and/or drawing) here. This server asks Claude to
// rewrite it as a short phrase made of words the game engine already knows, e.g.
//   "a bunch of chimps packing sci-fi blasters"  ->  "five monkeys with ray guns"
//   (a drawing of a cat)                          ->  "cat"
// The game then builds the ability from that phrase. The API key never leaves this server.
//
// Settings (in the .env file next to this script, or as environment variables on a host):
//   ANTHROPIC_API_KEY   your Anthropic API key (required)
//   GAME_SECRET         any long random text; must match AI_SECRET in the game's AIConfig script (required)
//   PORT                port to listen on (default 8787)
//   MODEL               Claude model id (default claude-opus-5-5)
//
// Run:  npm install   then   npm start

import http from "node:http";
import zlib from "node:zlib";
import Anthropic from "@anthropic-ai/sdk";

const PORT = Number(process.env.PORT || 8787);
const MODEL = process.env.MODEL || "claude-opus-5-5";
const SECRET = process.env.GAME_SECRET || "";
const MAX_BODY = 16 * 1024;

// Models that accept the server-side refusal fallback.
const FALLBACK_MODELS = new Set(["claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5", "claude-fable-5-2", "claude-fable-5-1"]);

if (!SECRET) {
  console.error("GAME_SECRET is not set. Refusing to start: without it anyone could spend your API credit.");
  process.exit(1);
}

if (!process.env.ANTHROPIC_API_KEY) {
  console.warn("Warning: ANTHROPIC_API_KEY is empty. The helper will run, but every prompt will fall back to the game's word engine.");
}

// The game waits about 8 seconds, so fail fast instead of retrying.
const client = new Anthropic({ timeout: 7000, maxRetries: 0 });

let vocab = null; // sent by the game when its server starts, so the word list never drifts
let systemPrompt = null;
const cache = new Map(); // typed prompt -> phrase
const stats = { requests: 0, input: 0, cached: 0, output: 0 }; // token totals since the helper started (see /health)

function buildSystemPrompt(v) {
  const list = (words) => words.join(", ");
  return `You translate player prompts for a silly kids' arena game on Roblox. Players type or draw ANYTHING and fight with it. The game engine only understands a simple phrase built from its own word list. Your job: rewrite the player's idea as that phrase, keeping as much of the joke as you can.

PHRASE GRAMMAR (use the parts you need, in this order):
  [HOW MANY] [DESCRIBING WORDS] THING [with WEAPON] [riding THING] [that shoots THING]
Other forms:
  DISASTER                      e.g. "nuke", "tsunami"
  THING DISASTER                e.g. "shark tornado", "piano meteor"   (a disaster made of that thing)
  raining THINGS                e.g. "raining pianos"
  [DESCRIBING WORDS] me         e.g. "giant me", "fast me"             (changes the player)
  i am a CREATURE               e.g. "i am a shark"                    (the player transforms)

WORD LIST (use ONLY these words, plus plurals and number words):
CREATURES: ${list(v.creature)}
WEAPONS: ${list(v.weapon)}
OBJECTS: ${list(v.object)}
DISASTERS: ${list(v.event)}
STRUCTURES: ${list(v.structure)}
SELF BUFFS: ${list(v.buff)}
DESCRIBING WORDS: ${list(v.adjectives)}
HOW MANY: ${list(v.counts)}

RULES:
- Reply with the phrase ONLY: lowercase, no punctuation, at most 12 words. No explanation.
- Always produce something. If nothing fits, pick the closest silly match from the word list.
- Keep the player's numbers, sizes, elements and colours when they gave them.
- A plural THING means a group, so use a plural for groups ("monkeys", not "monkey").
- Named characters, creatures and powers from anime, manga, comics, films, cartoons, video games, memes and
  mythology: you know thousands of them. Never refuse and never output the name itself. Translate each one into
  the words above that best capture its signature look and power. Examples: a wheel-backed adapting shikigami ->
  "wheelgeneral"; a colossal skinless giant -> "titan"; a city-smashing lizard -> "kaiju"; a piloted giant robot ->
  "mecha"; a hero who shoots webs -> "webshooter"; a caped flyer with heat vision -> "flight" or "lasereyes"; a green
  rage giant -> "brute"; a thunder god's hammer -> "thunderhammer"; a ki blast -> "energybeam"; a transformation or
  aura -> "powerup"; a three-headed hound -> "cerberus". If nothing special fits, describe them with ordinary words
  (e.g. "fast ninja with a katana", "giant flaming skeleton").
- For a drawing, decide what it most looks like. If a caption is given, trust the caption over the picture.
- "Instant win", "kill everyone", "infinite health" and similar become something weak and funny, e.g. "tiny chicken".
- If the prompt is sexual, hateful, or about a real person, reply exactly: blob`;
}

// --- tiny PNG encoder so a drawing can be sent to the model as an image ---------------------
const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
// doodle: grid*grid characters, "." = empty, "a".."j" = palette index. Returns a base64 PNG.
function doodleToPng(doodle, grid, palette) {
  const scale = 8;
  const size = grid * scale;
  const raw = Buffer.alloc((size * 3 + 1) * size);
  for (let y = 0; y < size; y++) {
    const row = y * (size * 3 + 1);
    raw[row] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const ch = doodle[Math.floor(y / scale) * grid + Math.floor(x / scale)];
      const rgb = ch === "." ? [255, 255, 255] : palette[ch.charCodeAt(0) - 97] || [0, 0, 0];
      raw.set(rgb, row + 1 + x * 3);
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 2, 0, 0, 0], 8); // 8-bit RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", zlib.deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]).toString("base64");
}

// --- the model call -------------------------------------------------------------------------
async function interpret(text, doodle) {
  const content = [];
  if (doodle) {
    content.push({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: doodleToPng(doodle, vocab.grid, vocab.palette) },
    });
    content.push({ type: "text", text: text ? `Player's drawing. Caption: "${text}"` : "Player's drawing. No caption." });
  } else {
    content.push({ type: "text", text: `Player's prompt: "${text}"` });
  }

  const useFallback = FALLBACK_MODELS.has(MODEL);
  const response = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 2000,
    output_config: {
      effort: "low", // a short rewrite; keeps the wait short
      // Force the answer to be exactly { "phrase": "..." } so the model cannot reply with an explanation.
      format: {
        type: "json_schema",
        schema: {
          type: "object",
          properties: { phrase: { type: "string", description: "The engine phrase only: lowercase words from the word list, at most 12 words." } },
          required: ["phrase"],
          additionalProperties: false,
        },
      },
    },
    system: [{ type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content }],
    ...(useFallback ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" } : {}),
  });

  if (response.stop_reason === "refusal") return null; // the game falls back to its own word engine
  let phrase = "";
  for (const block of response.content) {
    if (block.type === "text") phrase += block.text;
  }
  try {
    phrase = String(JSON.parse(phrase).phrase ?? "");
  } catch {
    // not JSON (should not happen with the schema above): fall through and clean up whatever came back
  }
  // running totals, so you can see what the helper is costing
  const u = response.usage;
  stats.requests += 1;
  stats.input += u.input_tokens + (u.cache_creation_input_tokens ?? 0);
  stats.cached += u.cache_read_input_tokens ?? 0;
  stats.output += u.output_tokens;
  phrase = phrase.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
  return phrase || null;
}

// --- HTTP -----------------------------------------------------------------------------------
function send(res, status, data) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(data));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const parts = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error("body too large"));
        req.destroy();
      } else {
        parts.push(chunk);
      }
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(parts).toString("utf8")));
      } catch {
        reject(new Error("bad json"));
      }
    });
    req.on("error", reject);
  });
}

const isWordList = (v) => Array.isArray(v) && v.length > 0 && v.length < 2000 && v.every((w) => typeof w === "string" && /^[a-z0-9]{1,24}$/.test(w));

const server = http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/health") return send(res, 200, { ok: true, model: MODEL, hasVocab: vocab !== null, stats });
  if (req.method !== "POST") return send(res, 404, { error: "not found" });
  if (req.headers["x-game-secret"] !== SECRET) return send(res, 401, { error: "wrong secret" });

  let body;
  try {
    body = await readJson(req);
  } catch (err) {
    return send(res, 400, { error: err.message });
  }

  // The game uploads its word list once when its server starts.
  if (req.url === "/vocab") {
    const ok =
      ["creature", "weapon", "object", "event", "structure", "buff", "adjectives", "counts"].every((k) => isWordList(body[k])) &&
      Number.isInteger(body.grid) && body.grid >= 8 && body.grid <= 64 &&
      Array.isArray(body.palette) && body.palette.length <= 10 &&
      body.palette.every((c) => Array.isArray(c) && c.length === 3 && c.every((n) => Number.isInteger(n) && n >= 0 && n <= 255));
    if (!ok) return send(res, 400, { error: "bad vocab" });
    vocab = body;
    systemPrompt = buildSystemPrompt(body);
    cache.clear();
    console.log(`word list received: ${body.creature.length + body.weapon.length + body.object.length + body.event.length} things`);
    return send(res, 200, { ok: true });
  }

  if (req.url !== "/interpret") return send(res, 404, { error: "not found" });
  if (!vocab) return send(res, 409, { error: "need vocab" });

  const text = typeof body.text === "string" ? body.text.slice(0, 80).replace(/["\n\r]/g, " ").trim() : "";
  const doodle =
    typeof body.doodle === "string" && body.doodle.length === vocab.grid * vocab.grid && /^[.a-j]+$/.test(body.doodle) ? body.doodle : null;
  if (!text && !doodle) return send(res, 400, { error: "nothing to interpret" });

  const key = doodle ? null : text.toLowerCase();
  if (key && cache.has(key)) return send(res, 200, { text: cache.get(key), cached: true });

  try {
    const phrase = await interpret(text, doodle);
    if (!phrase) return send(res, 200, { text: null });
    if (key) {
      if (cache.size > 5000) cache.clear();
      cache.set(key, phrase);
    }
    console.log(`${doodle ? "[drawing] " : ""}"${text}" -> "${phrase}"`);
    return send(res, 200, { text: phrase });
  } catch (error) {
    if (error instanceof Anthropic.AuthenticationError) {
      console.error("The API key was rejected. Check ANTHROPIC_API_KEY.");
    } else if (error instanceof Anthropic.RateLimitError) {
      console.error("Rate limited by the API.");
    } else if (error instanceof Anthropic.APIConnectionError) {
      console.error("Could not reach the API (or it took longer than 7 seconds).");
    } else if (error instanceof Anthropic.APIError) {
      console.error(`API error ${error.status}: ${error.message}`);
    } else if (!process.env.ANTHROPIC_API_KEY) {
      console.error("No API key. Paste your Anthropic API key into the .env file, then restart the helper.");
    } else {
      console.error(error);
    }
    return send(res, 502, { error: "ai failed" }); // the game falls back to its own word engine
  }
});

server.listen(PORT, () => console.log(`Prompt Brawl AI helper listening on port ${PORT} (model ${MODEL})`));
