# Knowledge base format

Each file in this folder is a JSON array of entries. The AI helper (`server.js`) looks up the
names in a player's prompt and hands the matching entries to the model as reference notes, so a
kid typing "ahri with bork" gets something true to the source.

The game is a kids' Roblox brawler: players type anything and fight with what it becomes
(a summoned creature, a weapon in the hand, a disaster, a self buff, a vehicle, or the player
transforming into a character). Nothing may be overpowered.

## Entry

```json
{
  "names": ["blade of the ruined king", "bork", "botrk", "ruined king blade"],
  "kind": "item",
  "from": "League of Legends",
  "facts": "Sword that deals extra damage based on the target's health, steals life on every hit and slows the target on the first strike.",
  "look": "long curved teal-glowing ghostly sword with a jagged dark blade and a spiked crossguard",
  "use": "melee weapon",
  "trait": "lifesteal",
  "attack": "melee",
  "element": "dark",
  "flies": false,
  "speed": 3, "strength": 3, "toughness": 3,
  "specials": [],
  "color": "#3FE0C5"
}
```

Fields:

- `names` (required): lowercase, letters digits and spaces only. EVERY way a 12 to 20 year old
  would type it: full name, short name, nickname, common misspellings, abbreviations. 1 to 5
  words each. Do not include a name so generic it would match ordinary words ("flash" is fine
  for the hero only if you also give "the flash"; never "fire", "king", "ash" on their own
  unless that single word really is the thing's usual name and is unlikely to mean anything else).
- `kind` (required): `character` (a person or humanoid), `creature` (monster, animal, pet),
  `item` (weapon, armour, tool, consumable), `ability` (a technique or spell), `vehicle`,
  `event` (a disaster or arena-wide effect).
- `from` (required): the game, anime, film, show, book or meme it comes from.
- `facts` (required): at most 45 words. What it actually does in the source: signature moves,
  effects, how it fights. Accurate. No lore, no plot, no opinions.
- `look` (required): at most 35 words, for a 3D artist who has never heard of it: build, hair,
  colours, outfit pieces, held item, distinctive features. NEVER a name of a person, character,
  show, game or brand. It goes to a 3D generator with strict child-safety moderation, so never
  use: skinless, skin, naked, nude, bare, shirtless, flesh, blood, gore, wound, corpse, dead,
  kill, sexy. Always dressed. Describe scary things by colour and shape.
- `use` (required): what it becomes in the game, one of: `summon`, `melee weapon`,
  `ranged weapon`, `thrown weapon`, `self buff`, `disaster`, `structure`, `vehicle`.
  Characters and creatures are `summon`.
- `trait` (weapons and items only, else `"none"`): one of `none`, `lifesteal`, `burn`, `freeze`,
  `shock`, `poison`, `knockback`, `rapid` (fast weak hits), `heavy` (slow huge hits).
- `attack`: `melee` (punches, swords, claws), `ranged` (guns, thrown things, bolts), `beam`
  (lasers, energy beams), `blast` (explosions, big energy balls).
- `element`: `none`, `fire`, `ice`, `electric`, `poison`, `dark`, `holy`, `water`.
- `flies`: true only if it really flies or hovers.
- `speed`, `strength`, `toughness`: 1 (feeble) to 5 (legendary), honest and relative to each
  other. BALANCE RULE: the three must add up to 12 or less, and to 10 or less for anything that
  is not a top-tier powerhouse in its source. A god-tier character is 4/4/4 or 5/5/2, never 5/5/5.
- `specials`: zero to three of `teleport` (blinks, dashes through space), `heal` (regenerates),
  `shield` (force fields, invulnerable moments), `adapt` (tougher the more it is hit), `leap`
  (jumps in and slams), `pull` (hooks, webs, grapples, telekinesis), `aura` (hurts everything
  nearby), `clones` (comes with copies or minions), `grow` (turns giant), `lifesteal` (drains
  life), `spin` (whirls blades, chains or itself), `freeze` (freezes or stuns enemies in place),
  `slide` (glides on its own path: ice slides, surfing, skating), `dash` (a burst of super speed
  that bowls enemies over). Only ones the thing really has, most famous first. When a player
  becomes the character, `leap`, `dash`, `freeze` and `spin` are what the F key does.
- `color`: the signature glow colour as `#RRGGBB`, or `""`.

Rules: valid JSON, UTF-8, no comments, no trailing commas. One entry per distinct thing (forms
of one character that play very differently may be separate entries). No real people. Nothing
sexual or hateful.
