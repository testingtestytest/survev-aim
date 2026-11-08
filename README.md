# AIM/SURVEV

A 2D aim trainer for survev.io. It's plain HTML, CSS and JS, with no build step.

## Run
Double-click `index.html`, or serve the folder with `python -m http.server 8000` and open http://localhost:8000.
- `index.html#play=sv-1v1` starts a mode directly. Mode ids: `normal`, `flick`, `tracking`, `sv-range`, `sv-1v1`.
- `#set=<id>` opens that mode's settings.

## Standard modes
- **Normal**: targets grow, stay at full size, shrink to a small size and stay there, then vanish. Choose difficulty, size, and timer or lives.
- **Flick**: one target at a time. Choose size, flick distance, timeout, and timer or lives.
- **Tracking**: hold LMB and follow a moving target. Choose smooth, strafe or mixed movement, speed and size.

## Survev modes
Real survev weapons, using the game's own numbers. You're always at the center of the screen and move with WASD.
- **Quickswitch**: a bot strafes and moves between ranges. A timeline shows every shot, every hit, and each switch delay (green means it was a free switch).
- **1v1**: the bot strafes, moves between ranges, rushes you at the chosen frequency and fights back with chosen weapons, mostly mag dumping automatic guns with an occasional short burst.

**Bot distance** defaults to **Dynamic**: the bot picks a random distance from 4 to 24 units, holds loosely around it while slowly drifting, and picks another after 1.5–6 seconds. If you retreat it lets you go instead of following, and it gets back out after a rush or brawl. It stays on your screen at any scope. **Close**, **Mid**, **Far** and **Long** hold one fixed distance instead, and Far and Long can go off screen at low zoom.

The bot respawns at a random spot on your screen, at least 6 units from you, so higher scopes spread it further. The exception is a **Still** bot at a fixed distance, which keeps that distance.

A rush ends when the bot reaches you. If you keep getting away, it gives up after about 2 seconds, plus extra time when it starts from further than 12 units.

In 1v1 the bot carries an **AK-47 and Mosin** by default. You can change either, or leave out the second. It changes guns when one runs out, and alternates two guns with quickswitches after single shots. With a shotgun and another gun, it wants the shotgun closer than 10 units and the other gun beyond 14. Skill sets how often and how quickly it does all this, and whether it reloads both guns before fighting again. Guns that load shell by shell get a partial reload before it fires again, and better bots load more.

With rocks and trees on, the bot finds its way around them with A* pathfinding, using the same 8 directions as a player's keys. It paths to you when it's closing in, or when it has lost sight of you for a while. It avoids obstacles while strafing, and it holds fire instead of shooting one in the way. Skill sets how quickly it updates its path, how soon it comes looking for you, and how well it holds fire. The pathfinding is this trainer's own design; the game has no bots like this.

With a **pan** as its melee, the bot uses it when it can't shoot, such as during a reload or a switch delay. It turns the pan on its back toward you to deflect your shots, then turns back in time to fire. If it's holding the pan, it does the same with the one in its hand. Skill sets how often it does this and how accurately. The results screen counts what it deflected.

The bot can also fight with **melee**, fists by default, and you can choose its weapon with **BOT MELEE**. The weapon's reach sets when it attacks: it switches and swings from further away with a Naginata (reach 6.5) than with fists (3.25), and stays toward the end of a long weapon's reach. When you're super close it may switch to melee, and when you're within about 10 units (more with a long weapon) it sometimes charges you with melee. Charges get up to 5 times more likely as its health runs out, and a bot set to never rush doesn't charge. Skill sets how likely both are.

With one gun, a bot on a slow single-shot gun such as a sniper can pull out melee between shots. Any switch clears the post-shot slowdown, so it strafes at full speed and still fires as often. Skill sets how often it does this.

**Bot skill** (both modes) sets how well it strafes, aims and how often it tries to dodge. **Bot dodges bullets** turns dodging on or off, and **dodge reaction time** sets how long a bullet must be in the air before the bot notices it. Bullet flight is short, so at a given range fast guns can arrive before it reacts at all. The bot's movement, aim and dodging are this trainer's own design, not code from the game.

In both modes you can choose your loadout (primary, secondary, melee; Mosin, SPAS-12 and frying pan by default), the bot's armor level (the preview shows the damage your loadout does to it), scope, and whether damage numbers are shown.

### Mechanics ported from the survev source
- **Switching** (`server/src/game/weaponManager.ts`):
  - The next gun's cooldown becomes its `switchDelay` (0.75s for most guns, 1.0s for bolt-action snipers).
  - A **free switch** costs only 0.25s and becomes available again 1s after the last one.
  - Every switch instantly clears the slowdown from your last shot.
  - Guns that share a deploy group (M870, SPAS-12, SPAS-16) never get the free switch while the current one is on cooldown.
  - You can't switch in the middle of a burst.
- **Movement** (`player.ts recalculateSpeed`):
  - Base speed is 12.
  - Your weapon's equip speed is added (melee +1).
  - After a shot, the gun's `speed.attack` is added and the result is halved, until `fireDelay` runs out.
- **Firing:**
  - auto, single (clicks within the last 0.1s are buffered) and burst modes
  - `shotSpread`, plus `moveSpread` while moving, and first-shot accuracy where the gun has it
  - pellets and jitter for shotguns
  - random ±1 unit on bullet range, and damage falloff over distance
- **Reload:**
  - Uses `reloadTime`, and shotguns load shell by shell.
  - An empty Mosin uses the full 3.0s reload.
  - Switching weapons cancels a reload.
- **Damage:**
  - Each hit has a 15% headshot chance, which multiplies damage by the gun's `headshotMult`. Melee never headshots.
  - Vest reduction: 25 / 38 / 45% at levels 1–3. It doesn't apply to headshots.
  - Helmet reduction: 25 / 40 / 55% at levels 1–3. It applies fully on headshots and at 30% strength on body shots.
  - Reductions multiply. Example: a 72-damage Mosin body shot into a level 1 vest and helmet does 72 × 0.75 × 0.925 = 49.95.
  - Damage falls off slightly with distance. Damage dealt is capped at the target's remaining health.
  - Helmet and vest are set separately for the bot (both modes) and for you (1v1).
- **Melee:** each weapon's hit offset, hit radius, damage timing and swing cooldown.
- **Frying pan** (`objects/bullet.ts`, `objects/player.ts`):
  - It blocks bullets in your hand, except during a swing, and on your back while you hold anything else. Each position only covers its own small area, so you can still be hit around it.
  - A blocked bullet bounces off at the mirror angle, up to 3 times. Each bounce divides its range by 1.5 and its damage by the number of bounces plus one.
  - A reflected bullet can hit whoever fired it. In this trainer, damage and kills from the bot's reflected shots count for you.
- **HUD** (`client/css/game.css`, `ui/ui2.ts`, `ui/pieTimer.ts`): the slots, ammo, health colors, adrenaline bar, armor, scope and reload timer use the game's sizes, positions and colors. The trainer adds a health number, weapon cooldown bars, free switch status, speed, bot health, and the shot timeline. On desktop, time stays in the game's top-right box, with kills (or damage) left of the bot's health and deaths to its right.

The weapon data in `js/survev/data.js` was generated by importing survev's TypeScript definitions directly, not copied by hand.

- **Blood impacts** (`client/src/objects/particles.ts`, `objects/bullet.ts`, `objects/player.ts`): the game's three splat sprites, growing and fading over 0.5s. Bullet blood stays on the player at the point of impact, and melee blood drifts along the swing. Turn it off under **KEYBINDS AND SETTINGS**, or **SETTINGS** on phones. The game's hit sounds aren't included, as the trainer has no audio.
- **Rocks and trees** (`objects/obstacle.ts`, `mapObstacleDefs.ts`, `map.ts`, `objects/bullet.ts`, `objects/player.ts`, `weaponManager.ts`). Turn them on with **ROCKS AND TREES**: **Normal** is the game's density of each, **Few** is half and **Many** is double.
  - A rock has 250 health and radius 1.6, sized 1–1.2. A tree has 175 health and radius 1.55, sized 0.8–1. Both shrink to half their size as they take damage, then leave a wreck you can walk and shoot through.
  - You can't walk through them. Bullets stop on them and do their damage times the bullet's obstacle multiplier (1.5 for the Mosin). Melee hits a player first, and an obstacle in the way protects the player.
  - A barrel poking into an obstacle fires from its near side. Rocks are drawn under players and tree canopies over them, so you can lose sight of someone under a tree.
  - Not included: wood and rock chips, hit sounds, and other map objects such as bushes and crates. This trainer also leaves a gap between obstacles so you always fit; the game only stops them overlapping.
- **Adrenaline** (`player.ts`): 0–100.
  - Heals 0.5 / 1.25 / 1.5 / 1.75 HP per second across its four tiers, which end at 25 / 50 / 87.5 / 100.
  - Adds 1.85 speed at 50 or above, before the post-shot halving.
  - Drains 0.375 per second. Draining can be turned off as a training aid.
- **Melee visuals:** the game's sprites, hand poses, and attack and deploy animations (`client/src/animData.ts`). Inspect animations aren't included.

Survev modes open in **SIMPLE** settings with just the essentials. **FULL** shows everything, and anything hidden keeps its value.

## Phones and tablets
Phones and tablets are detected the way survev does it, so a touchscreen laptop stays in desktop mode. Standard modes use taps, or a held finger for Tracking. Survev modes use survev's own mobile controls, ported from `client/src/ui/touch.ts`, the input code in `client/src/game.ts`, and the mobile rules in `client/css/game.css`:
- **Left side of the screen moves:** any angle, at full speed however far you push.
- **Right side aims:** you fire when you pull past 93% of the stick's range, so a smaller pull aims without firing.
- **Facing:** if you move without aiming for 0.5s, you turn to face where you're walking.
- **Buttons:** tap a weapon slot to switch, and tap the ammo count or the bullets icon to reload.
- **Zoom:** scopes use the game's mobile values, so 1x shows more of the map than on desktop (radius 32 instead of 28).
- **Options in FULL:** move stick and aim stick can be **Anywhere** (the default) or **Fixed**, and the aim line can be turned off.

The X in the top-right corner goes back to the menu. Browsers can hold back the first few pixels of finger movement, so a very small pull may not register.

## Keybinds
Open **KEYBINDS AND SETTINGS** from the menu. Defaults:

| Action | Keys |
|---|---|
| Move | WASD / arrow keys |
| Primary | 1 |
| Secondary | 2 |
| Melee | 3 / E |
| Swap | Space |
| Reload | R |

Space swaps primary and secondary. While holding melee, it goes back to the last gun you held. With only one gun, it swaps between that gun and melee.

## Crosshair
Open **CROSSHAIR** from the menu to choose one of survev's 30 crosshair styles. Color, size and outline thickness can be changed. It's used as the real OS cursor, so it doesn't lag behind the mouse.

## Credits / license
The crosshairs, weapon stats and all sprites in `assets/survev/` come from [survev](https://github.com/survev/survev), which is licensed under **GPL-3.0**. This project is licensed under GPL-3.0 as well; see [LICENSE](LICENSE).
