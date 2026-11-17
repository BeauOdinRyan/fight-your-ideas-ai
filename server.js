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
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
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

// The game waits about 11 seconds, so fail fast instead of retrying.
const client = new Anthropic({ timeout: 10000, maxRetries: 0 });

let vocab = null; // sent by the game when its server starts, so the word list never drifts
let systemPrompt = null;
const cache = new Map(); // typed prompt -> phrase
const stats = { requests: 0, input: 0, cached: 0, output: 0 }; // token totals since the helper started (see /health)

// --- knowledge base ---------------------------------------------------------------------------
// The kb folder holds facts about characters, items, abilities and vehicles from games, anime,
// films, shows, books and memes (see kb/FORMAT.md). When a prompt names one of them, its entry
// is handed to the model as a reference note, so "ahri with bork" comes out true to the source
// and inside the game's power limits. To teach the game something new, add an entry to a file
// in kb (or add a new .json file there) and restart the helper.
const KB_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "kb");
const kbIndex = new Map(); // normalised name -> entry
const kbSingles = []; // one-word names of 6+ letters, for forgiving typos
let kbCount = 0;
const norm = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();

function loadKb() {
  let files = [];
  try {
    files = fs.readdirSync(KB_DIR).filter((f) => f.endsWith(".json"));
  } catch {
    console.warn("No kb folder found: the helper will work without reference notes.");
    return;
  }
  for (const file of files) {
    try {
      const entries = JSON.parse(fs.readFileSync(path.join(KB_DIR, file), "utf8"));
      for (const e of entries) {
        if (!e || !Array.isArray(e.names) || !e.facts) continue;
        kbCount += 1;
        for (const name of e.names) {
          const key = norm(name);
          if (key.length < 2 || kbIndex.has(key)) continue;
          kbIndex.set(key, e);
          if (!key.includes(" ") && key.length >= 6) kbSingles.push(key);
          const squashed = key.replace(/ /g, ""); // "kai sa" also answers to "kaisa"
          if (squashed !== key && squashed.length >= 5 && !kbIndex.has(squashed)) kbIndex.set(squashed, e);
        }
      }
    } catch (err) {
      console.warn(`Could not read kb/${file}: ${err.message}`);
    }
  }
  console.log(`knowledge base: ${kbCount} entries, ${kbIndex.size} names`);
}

// true when two words differ by one typo (one letter changed, added, dropped or two swapped)
function oneTypo(a, b) {
  if (a === b || Math.abs(a.length - b.length) > 1 || a[0] !== b[0]) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  const restA = a.slice(i), restB = b.slice(i);
  return (
    restA.slice(1) === restB.slice(1) || restA.slice(1) === restB || restA === restB.slice(1) ||
    (restA.length > 1 && restB.length > 1 && restA[0] === restB[1] && restA[1] === restB[0] && restA.slice(2) === restB.slice(2))
  );
}

// The entries a prompt names, longest names first, at most six.
function lookupKb(text) {
  const words = norm(text).split(" ").filter(Boolean).slice(0, 40);
  const taken = new Array(words.length).fill(false);
  const found = [];
  for (let len = Math.min(5, words.length); len >= 1 && found.length < 6; len--) {
    for (let i = 0; i + len <= words.length && found.length < 6; i++) {
      if (taken.slice(i, i + len).some(Boolean)) continue;
      const phrase = words.slice(i, i + len).join(" ");
      let entry = kbIndex.get(phrase);
      if (!entry && len === 1) {
        const w = words[i];
        if (w.endsWith("s") && w.length > 3) entry = kbIndex.get(w.slice(0, -1)); // plurals
        if (!entry && w.length >= 6) {
          const close = kbSingles.find((k) => oneTypo(w, k));
          if (close) entry = kbIndex.get(close);
        }
      }
      if (entry && !found.includes(entry)) {
        found.push(entry);
        for (let k = i; k < i + len; k++) taken[k] = true;
      }
    }
  }
  return found;
}

function kbNote(e) {
  const bits = [`- ${e.names[0]} [${e.kind || "thing"}${e.from ? ", from " + e.from : ""}]: ${e.facts}`];
  if (e.look) bits.push(`Looks like: ${e.look}.`);
  const hints = [];
  if (e.use) hints.push(`becomes a ${e.use}`);
  if (e.trait && e.trait !== "none") hints.push(`trait ${e.trait}`);
  if (e.attack) hints.push(`attack ${e.attack}`);
  if (e.element && e.element !== "none") hints.push(`element ${e.element}`);
  if (e.flies) hints.push("flies");
  if (e.speed) hints.push(`speed ${e.speed} strength ${e.strength} toughness ${e.toughness}`);
  if (Array.isArray(e.specials) && e.specials.length) hints.push(`specials ${e.specials.join(", ")}`);
  if (e.color) hints.push(`glow ${e.color}`);
  if (hints.length) bits.push(`In the game: ${hints.join("; ")}.`);
  return bits.join(" ");
}
loadKb();

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
- CHARACTERS GET THEIR OWN POWERS. When the prompt is a character, person or creature (named or not), the phrase
  must be a creature (the closest body: human, ninja, knight, robot, wizard, an animal...) and you fill in "character"
  so it fights the way that character really does:
    attack   melee = punches, swords, claws.  ranged = guns, thrown things.  beam = energy beams, lasers, eye beams.
             blast = explosions, big energy balls, bombs.
    element  the element of its attacks, if any.
    flies    true only if it really flies or hovers.
    speed, strength, toughness   1 (feeble) to 5 (legendary). Be honest: a speedster is speed 5, toughness 2;
             a tank is toughness 5, speed 1. The three together must not exceed 12.
    specials Up to THREE signature tricks, the ones the character is actually known for, most famous first (an
             empty list if none fit): teleport (blinks, instant movement), heal (regenerates), shield (force fields,
             invulnerable moments), adapt (gets tougher the more it is hit), leap (jumps in and slams the ground),
             pull (webs, grapples, telekinesis, gravity), aura (hurts everything nearby), clones (comes with copies),
             grow (turns giant: titans, rage giants, size-changers), lifesteal (drains life: vampires, soul eaters),
             spin (whirls blades, chains, a tail or itself: chainsaw fighters, spinning-top and tornado attackers),
             freeze (freezes or stuns enemies in place: ice powers, stone gazes, time stops, paralysis),
             slide (glides on its own path: ice slides, surfing, grinding rails, skating, snowboarding),
             dash (a burst of super speed that bowls enemies over: speedsters, charging bulls, rolling attacks).
             When the player BECOMES the character, these are what the F key does, so choose the moves a fan
             would expect to press a button for. A chainsaw-headed devil hunter: leap, spin, heal. An ice hero who
             skates on ice: freeze, slide, shield. A red-suited speedster: dash, heal. A hedgehog who rolls: dash,
             spin. A rubber pirate: leap, grow, pull. A web-slinger: pull, leap. A gravity or time witch: freeze, pull.
             Be ACCURATE to the source: only give a power the character really has. A web-slinger gets pull and leap,
             not flight. A caped flying strongman gets shield, flies true, beam attack for heat vision.
    source   anime, superhero or myth when it is a NAMED character from one; otherwise none.
  Examples: a web-slinging hero -> ranged, pull, speed 4. A caped flying strongman -> melee, flies, strength 5,
  toughness 5, special shield. A spiky-haired martial artist who powers up -> beam, flies, special aura. A wheel-backed
  adapting shikigami -> melee, special adapt, toughness 5. A copy ninja -> melee, special clones. A speedster -> speed 5.
- "look" describes ONE of the thing so a 3D artist could model it without knowing the name. Never put a name in it.
  For a NAMED character this must be accurate enough that a fan would recognise them instantly. Describe, in this
  order: age and build, exact hairstyle and hair colour, eye colour and facial features or markings, each piece of
  their signature outfit with its colours, and their signature weapon or item. Use the form fans picture first, which
  is usually their most powerful or iconic one: a titan shifter in titan form (towering muscular giant with a red
  muscle-patterned body, long dark hair, pointed ears, a wide toothy grimace, dark shorts), a transforming fighter in their powered-up form (golden spiky
  hair, glowing aura), a ninja in their orange jumpsuit with whisker marks and headband. Get the details right:
  wrong hair colour or outfit ruins it. Never describe a generic "boy", "man" or "girl" for a known character.
- The "look" is sent to a 3D generator with strict child-safety moderation that REJECTS anything gory or
  undressed. Never use words such as skinless, skin, naked, nude, bare, shirtless, flesh, blood, gore, wound, corpse,
  dead, kill. Always dress the figure (shorts, armour, a suit). Describe scary things by colour and shape instead:
  "red muscle-patterned body", "bone-white armour", "glowing red eyes".
- WEAPONS: pick the weapon word that matches how it really works. A pistol, rifle or revolver is "gun" (one accurate
  shot at a time). Only use "shotgun" for an actual shotgun, and "minigun" for an actual rapid-fire gun. Use a weapon
  word in the SINGULAR unless the player asked for several. Fill in "shot" with what the weapon fires.
- "self": true when the player wants to BE the thing or HAVE its powers rather than summon it: "superman's powers",
  "i am goku", "turn me into a dragon", "become a werewolf", "give me spiderman abilities", "flash speed". Still write
  the phrase, look and character block for that character exactly as if it were summoned (is_character true), so
  the game knows what powers and appearance to give the player. false for everything else, including a plain name
  ("superman" alone summons him). When self is true the phrase is ALWAYS the character as a creature ("ice human",
  "fast ninja"), never a disaster, weapon or buff, even if their power is ice, fire or storms: "make me an ice
  hero" is the hero, not a blizzard.
- "skin": fill in "skin" whenever the idea is ONE KIND of human-shaped character: when "self" is true (the player
  becomes it), AND ALSO when a human-shaped character is summoned ("superman", "goku", "3 ninjas", "a knight",
  "yasuo", "a wizard", "robot soldier"). Human-shaped means it stands on two legs with two arms and a head, about
  the build of a person: heroes, villains, anime and game characters, soldiers, wizards, humanoid robots and
  aliens. The game then dresses a blocky Roblox character in this outfit, which can really walk, run, punch and
  fly. It is how to dress a blocky Roblox avatar as that character. Every colour is a hex code like "#1E3A8A"; use "" for "none / not there". Be accurate to the character:
    skin_color (face and any bare limbs; green, blue, grey etc. for non-human skin), hair (none, short, spiky, long,
    ponytail, twin_tails) and hair_color, top_color (shirt or suit torso), sleeves (long = arms covered in the top
    colour, short = upper arms only, none = bare arms), gloves_color, pants_color, boots_color, emblem (none, circle,
    diamond: a chest symbol) and emblem_color, belt_color, mask (none, full = whole head covered like a web-slinger
    or armoured hero, eyes = a band across the eyes, cowl = top of the head with pointed ears) and mask_color,
    eye_glow_color (only for glowing eyes or mask lenses), headgear (none, headband, horns, crown, helmet, hat,
    halo, ears) and headgear_color, back (none, cape, wings, sword, shell, tail, jetpack) and back_color, aura_color
    (a glowing aura, e.g. gold for a powered-up martial artist).
  For anything that is NOT human-shaped (animals, dragons, kaiju, monsters with other body shapes, giants many
  times a person's size, vehicles, objects, weapons, disasters, buffs), set every skin colour to "" and every
  choice to "none": those keep their own generated 3D model.
- VEHICLES the player can drive have their own words. A plain car, truck, bike or other road vehicle -> "car". A
  plain plane, jet, helicopter or bomber -> "plane". A plain tank or killdozer -> "killdozer". A plain "bulldozer"
  stays "bulldozer" (it drives itself and fights for the player). Use the single word alone, with self false and
  is_character false.
- RIDING ANYTHING ELSE: when the player asks to ride, drive, pilot or fly something that is not a plain car, plane
  or tank ("let me ride a star destroyer", "pilot a giant drill robot", "ride a dragon", "drive the batmobile"),
  set vehicle.is_vehicle true and describe it: kind (ground = wheels, tracks, hovering low; air = flies; walker =
  walks on legs: mechs, giant robots, ridden beasts), size 1 (bike) to 5 (capital ship), speed and toughness 1 to 5,
  and weapon (none, guns = rapid fire, cannon = big explosive shots, laser, bombs = dropped from the air, melee =
  rams, punches, drills). "look" must then describe the VEHICLE itself for a 3D artist (shape, colours, engines,
  weapons), never a name. The phrase can be the closest word ("mecha", "plane", "dragon"). Otherwise is_vehicle false.
  Only the PLAYER asking to ride counts. "a knight riding a dragon" or "goku riding a creeper" is a summoned creature
  on a mount: is_vehicle false, phrase "THING riding THING", and the character block describes the rider.
- "look" never contains a name, even when the reference notes or the prompt use one: write what it looks like instead
  ("silver spiky haired martial artist in an orange and blue gi", not the character's name). It describes ONE of the
  thing, never "a hundred cowboys".
- MIXED IDEAS: when a prompt combines two things, the result must clearly be BOTH. The phrase carries the mechanics
  and "look" carries the blend, described as one object or figure:
    a theme on a vehicle or object ("super saiyan plane") -> phrase "plane", look = a plane in that character's
    colours with their signature features (orange and blue paint, golden spiky flame crest, glowing golden aura);
    a character holding something ("purple titan with a lightsaber") -> phrase "... titan with sword", attack melee,
    and the look MUST show the character holding that exact item (a glowing red energy sword in his hand);
    a creature made of or dressed as something ("pizza dragon", "cowboy shark") -> both parts visible in the look.
  Never drop one half of a mix.
- "color": the one signature glow colour of the idea, as a hex code: an energy sword's blade colour, a powered-up
  form's aura (gold), a cursed blade's purple, a fire sword's orange. It colours weapon trails, slashes and auras.
  "" when the idea has no obvious glow.
- REFERENCE NOTES: the player's message may come with notes about characters, items, abilities or vehicles it
  names, taken from the game's own knowledge base. Trust them over your memory: build the phrase, look, character
  block, trait and colour from the note's facts, and use the note's "In the game" hints (what it becomes, attack,
  element, speed/strength/toughness, specials, glow) as your starting point. When the prompt combines several noted
  things ("ahri with bork", "creeper riding a hog rider"), blend them: the character keeps its own powers, the item
  becomes what it holds and adds its trait and glow. Ignore a note that clearly is not what the player meant.
- LONG SENTENCES: read the whole thing, then decide in this order: (1) what it IS (the one main thing: a creature,
  a weapon, a disaster, a vehicle, a transformation); (2) how many and how big; (3) at most THREE extras that change
  how it plays, picked by what the player stressed most: what it holds, what it rides, what it shoots, its element,
  one special power. Put those in the phrase. EVERYTHING else the player described (hats, colours, extra limbs,
  accessories, mood) goes into "look", so the model still shows it. Never drop the main thing, never return only
  an accessory, and never answer a long prompt with a random unrelated word.
- WEAPON TRAIT: for a weapon or item, set "trait" to the one effect it is known for: lifesteal (heals the wielder),
  burn, freeze, shock, poison, knockback, rapid (fast weak hits), heavy (slow huge hits), else none.
- KEEP IT FAIR. This is a multiplayer game, so nothing may be overpowered, however the prompt is worded:
    speed + strength + toughness is 12 at most, and 10 at most unless the thing is top-tier in its source;
    at most three specials, and "shield" plus "heal" plus "adapt" never all together;
    huge numbers ("a million", "infinite", "9999") become "army of" (the game caps how many appear);
    claims like "one shot", "unkillable", "invincible", "infinite damage", "instant kill", "god mode" are flavour
    only: keep the idea, give it normal power. Size words stop at "giant"/"colossal".
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
  const notes = text ? lookupKb(text) : [];
  if (notes.length) {
    content.push({
      type: "text",
      text: "REFERENCE NOTES for things this prompt seems to name (use a note only if it fits what the player means):\n" + notes.map(kbNote).join("\n"),
    });
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
          properties: {
            phrase: { type: "string", description: "The engine phrase only: lowercase words from the word list, at most 12 words." },
            look: { type: "string", description: "What ONE of it looks like, for a 3D artist: up to 35 plain words of appearance (build, hair, face, outfit pieces and colours, held items). No names of people, characters, shows or brands. Empty for a disaster." },
            shot: { type: "string", description: "If the phrase is a weapon that shoots or throws something: 1 to 3 words for what comes out (bullet, arrow, laser bolt, rocket, fireball, water, lightning, or something silly like bees or music notes). Empty otherwise." },
            self: { type: "boolean", description: "True when the player wants to become the thing or have its powers themselves, instead of summoning it." },
            character: {
              type: "object",
              description: "How it fights, when the prompt is a character, person or creature. Use the defaults (is_character false) otherwise.",
              properties: {
                is_character: { type: "boolean" },
                source: { type: "string", enum: ["none", "anime", "superhero", "myth"], description: "Where a NAMED character comes from; none for anything generic." },
                attack: { type: "string", enum: ["melee", "ranged", "beam", "blast"] },
                element: { type: "string", enum: ["none", "fire", "ice", "electric", "poison", "dark", "holy", "water"] },
                flies: { type: "boolean" },
                speed: { type: "integer", enum: [1, 2, 3, 4, 5] },
                strength: { type: "integer", enum: [1, 2, 3, 4, 5] },
                toughness: { type: "integer", enum: [1, 2, 3, 4, 5] },
                specials: {
                  type: "array",
                  description: "Up to three signature tricks the character really has, most famous first. Empty if none.",
                  items: { type: "string", enum: ["teleport", "heal", "shield", "adapt", "leap", "pull", "aura", "clones", "grow", "lifesteal", "spin", "freeze", "slide", "dash"] },
                },
              },
              required: ["is_character", "source", "attack", "element", "flies", "speed", "strength", "toughness", "specials"],
              additionalProperties: false,
            },
            color: { type: "string", description: "Signature glow colour as a hex code like #FFD700, or empty." },
            trait: { type: "string", enum: ["none", "lifesteal", "burn", "freeze", "shock", "poison", "knockback", "rapid", "heavy"], description: "For a weapon or item: the one effect it is known for." },
            skin: {
              type: "object",
              description: "How to dress the player's Roblox avatar as the character, when self is true. Colours are hex codes like #1E3A8A, or empty for none.",
              properties: {
                skin_color: { type: "string" },
                hair: { type: "string", enum: ["none", "short", "spiky", "long", "ponytail", "twin_tails"] },
                hair_color: { type: "string" },
                top_color: { type: "string" },
                sleeves: { type: "string", enum: ["long", "short", "none"] },
                gloves_color: { type: "string" },
                pants_color: { type: "string" },
                boots_color: { type: "string" },
                emblem: { type: "string", enum: ["none", "circle", "diamond"] },
                emblem_color: { type: "string" },
                belt_color: { type: "string" },
                mask: { type: "string", enum: ["none", "full", "eyes", "cowl"] },
                mask_color: { type: "string" },
                eye_glow_color: { type: "string" },
                headgear: { type: "string", enum: ["none", "headband", "horns", "crown", "helmet", "hat", "halo", "ears"] },
                headgear_color: { type: "string" },
                back: { type: "string", enum: ["none", "cape", "wings", "sword", "shell", "tail", "jetpack"] },
                back_color: { type: "string" },
                aura_color: { type: "string" },
              },
              required: ["skin_color", "hair", "hair_color", "top_color", "sleeves", "gloves_color", "pants_color", "boots_color", "emblem", "emblem_color",
                "belt_color", "mask", "mask_color", "eye_glow_color", "headgear", "headgear_color", "back", "back_color", "aura_color"],
              additionalProperties: false,
            },
            vehicle: {
              type: "object",
              description: "Filled in when the player asks to ride, drive or pilot something that is not a plain car, plane or tank.",
              properties: {
                is_vehicle: { type: "boolean" },
                kind: { type: "string", enum: ["ground", "air", "walker"] },
                size: { type: "integer", enum: [1, 2, 3, 4, 5] },
                speed: { type: "integer", enum: [1, 2, 3, 4, 5] },
                toughness: { type: "integer", enum: [1, 2, 3, 4, 5] },
                weapon: { type: "string", enum: ["none", "guns", "cannon", "laser", "bombs", "melee"] },
              },
              required: ["is_vehicle", "kind", "size", "speed", "toughness", "weapon"],
              additionalProperties: false,
            },
          },
          required: ["phrase", "look", "shot", "self", "character", "color", "trait", "skin", "vehicle"],
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
  let look = "";
  let shot = "";
  let character = null;
  let self = false;
  let skin = null;
  let vehicle = null;
  let color = null;
  let trait = null;
  try {
    const parsed = JSON.parse(phrase);
    phrase = String(parsed.phrase ?? "");
    look = String(parsed.look ?? "").replace(/[^A-Za-z0-9 ,'-]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 260);
    // belt and braces: a name must never reach the 3D generator, so strip any knowledge-base name that slipped in
    for (const e of notes) {
      for (const n of e.names) {
        if (n.length >= 4) look = look.replace(new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi"), "");
      }
    }
    look = look.replace(/\s+/g, " ").replace(/^[ ,]+/, "").trim();
    shot = String(parsed.shot ?? "").toLowerCase().replace(/[^a-z ]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 30);
    if (parsed.character && parsed.character.is_character === true) character = parsed.character;
    self = parsed.self === true;
    if (character) character.special = (character.specials && character.specials[0]) || "none"; // older game versions read one
    // an outfit: for the player becoming a character, and for human-shaped summons (which get a real animated body)
    const hex = (v) => /^#[0-9a-fA-F]{6}$/.test(String(v ?? ""));
    if (parsed.skin && typeof parsed.skin === "object" && hex(parsed.skin.skin_color) && hex(parsed.skin.top_color) && hex(parsed.skin.pants_color)) {
      skin = parsed.skin;
    }
    if (parsed.vehicle && parsed.vehicle.is_vehicle === true) vehicle = parsed.vehicle;
    if (/^#[0-9a-fA-F]{6}$/.test(String(parsed.color ?? ""))) color = parsed.color;
    if (typeof parsed.trait === "string" && parsed.trait !== "none") trait = parsed.trait;
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
  return phrase ? { text: phrase, look, shot, self, power: character, skin, vehicle, color, trait } : null;
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
  if (req.method === "GET" && req.url === "/health") return send(res, 200, { ok: true, model: MODEL, hasVocab: vocab !== null, knowledge: kbCount, stats });
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
  if (key && cache.has(key)) return send(res, 200, { ...cache.get(key), cached: true });

  try {
    const answer = await interpret(text, doodle); // { text, look, power }
    if (!answer) return send(res, 200, { text: null });
    if (key) {
      if (cache.size > 5000) cache.clear();
      cache.set(key, answer);
    }
    const p = answer.power;
    console.log(`${doodle ? "[drawing] " : ""}"${text}" -> "${answer.text}"` + (p ? ` [${p.attack}, ${p.special}, spd ${p.speed} str ${p.strength} tgh ${p.toughness}${p.flies ? ", flies" : ""}]` : ""));
    return send(res, 200, answer);
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
