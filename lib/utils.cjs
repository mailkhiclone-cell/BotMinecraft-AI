'use strict';

// ══════════════════════════════════════════════════════════════════════
//  Utility functions extracted from bot.cjs for testability
// ══════════════════════════════════════════════════════════════════════

// ── ORE NAMES ─────────────────────────────────────────────────────────
const ORE_NAMES = {
  diamond_ore:'Kim cương', emerald_ore:'Ngọc lục bảo',
  gold_ore:'Vàng', lapis_ore:'Lapis', redstone_ore:'Đá đỏ',
  copper_ore:'Đồng', iron_ore:'Sắt', coal_ore:'Than', nether_quartz_ore:'Thạch anh',
  nether_gold_ore:'Vàng địa ngục',
};

function oreDisplayName(name) {
  const base = name.replace('deepslate_','');
  return ORE_NAMES[base] || ORE_NAMES[name] || name.replace(/_/g,' ');
}

// ── KEEP ITEMS ────────────────────────────────────────────────────────
const KEEP_ITEMS = new Set([
  'pickaxe','axe','shovel','sword','hoe','bow','crossbow','mace','trident',
  'helmet','chestplate','leggings','boots','shield','elytra',
  'totem_of_undying','ender_pearl','firework_rocket',
  'water_bucket','lava_bucket','milk_bucket',
  'arrow','spectral_arrow','tipped_arrow',
  'golden_apple','enchanted_golden_apple',
  'chest',
]);

function shouldKeep(name) {
  for (const k of KEEP_ITEMS) {
    if (name.includes(k)) return true;
  }
  return false;
}

// ── PROGRESS BAR ──────────────────────────────────────────────────────
function makeBar(val, max) {
  const pct = Math.max(0, Math.min(1, val / (max || 1)));
  const filled = Math.round(pct * 10);
  return '█'.repeat(filled) + '░'.repeat(10 - filled);
}

// ── ITEM ICONS ────────────────────────────────────────────────────────
const ITEM_ICONS = {
  'Diamond':'💎','Emerald':'💚','Gold Ingot':'🟡','Iron Ingot':'⬜',
  'Netherite Ingot':'🔳','Coal':'🪨','Log':'🪵','Wood':'🪵','Planks':'🪵',
  'Cobblestone':'🧱','Stone':'🧱','Sand':'🏜️','Dirt':'🟫','Gravel':'🪨',
  'Wheat':'🌾','Carrot':'🥕','Potato':'🥔','Sugar Cane':'🎋','Bamboo':'🎍',
  'Cactus':'🌵','Nether Wart':'🍄','Pumpkin':'🎃','Melon':'🍈',
  'Apple':'🍎','Bread':'🍞','Cooked Beef':'🥩','Rotten Flesh':'🧟',
  'Bone':'🦴','Arrow':'🏹','String':'🕸️','Gunpowder':'💥','Feather':'🪶',
  'Leather':'🟤','Beef':'🥩','Chicken':'🍗','Mutton':'🍖','Porkchop':'🥩',
  'Salmon':'🐟','Cod':'🐟','Tropical Fish':'🐠','Ink Sac':'🦑',
  'Potion':'🧪','Bucket':'🪣','Torch':'🔦','Chest':'📦',
  'Sword':'⚔️','Pickaxe':'⛏️','Axe':'🪓','Shovel':'🪚','Hoe':'🌱',
  'Shield':'🛡️','Bow':'🏹','Helmet':'⛑️','Chestplate':'🦺',
  'Leggings':'👖','Boots':'👢','Elytra':'🪂','Totem':'🗿',
  'Blaze Rod':'🔥','Ender Pearl':'💜','Eye of Ender':'👁️',
  'Obsidian':'⬛','Glass':'🪟','Book':'📖','Map':'🗺️','Compass':'🧭',
};

function getItemIcon(displayName) {
  const dn = (displayName || '').toLowerCase();
  for (const [key, icon] of Object.entries(ITEM_ICONS)) {
    if (dn.includes(key.toLowerCase())) return icon;
  }
  return '📦';
}

// ── VARINT ────────────────────────────────────────────────────────────
function readVarint(buf, offset) {
  let result = 0, shift = 0;
  while (offset < buf.length) {
    const b = buf[offset++];
    result |= (b & 0x7F) << shift;
    shift += 7;
    if (!(b & 0x80)) break;
  }
  return { value: result, bytesRead: offset };
}

// ── RPD ERROR DETECTION ───────────────────────────────────────────────
function _isRpdErrorMsg(errMsg) {
  const m = (errMsg || '').toLowerCase();
  return m.includes('quota') || m.includes('exceeded your') || m.includes('per day') || m.includes('daily');
}

// ── DATE UTILITY ──────────────────────────────────────────────────────
function _getTodayUTC() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
}

// ── SPONGE SCHEMATIC PARSER ───────────────────────────────────────────
function parseSpongeSchem(root) {
  const w = root.Width?.value ?? root.Width;
  const h = root.Height?.value ?? root.Height;
  const l = root.Length?.value ?? root.Length;
  if (!w || !h || !l) throw new Error('Sponge schem thiếu Width/Height/Length');

  const palette = root.Palette?.value ?? root.Palette;
  const idToName = {};
  for (const [name, v] of Object.entries(palette)) {
    const id = typeof v === 'object' ? v.value : v;
    idToName[id] = name.replace(/^minecraft:/, '').replace(/\[.*\]$/, '');
  }

  const rawBytes = root.BlockData?.value;
  const buf = Buffer.isBuffer(rawBytes) ? rawBytes : Buffer.from(rawBytes);
  const blockIds = [];
  let pos = 0;
  while (pos < buf.length) {
    const r = readVarint(buf, pos);
    blockIds.push(r.value);
    pos = r.bytesRead;
  }

  const blocks = [];
  for (let y = 0; y < h; y++) {
    for (let z = 0; z < l; z++) {
      for (let x = 0; x < w; x++) {
        const idx = (y * l + z) * w + x;
        if (idx >= blockIds.length) continue;
        const name = idToName[blockIds[idx]];
        if (!name || name === 'air') continue;
        blocks.push({ x, y, z, blockName: name });
      }
    }
  }
  return blocks;
}

// ── LITEMATICA PARSER ─────────────────────────────────────────────────
function parseLitematic(root) {
  const regions = root.Regions?.value ?? root.Regions;
  if (!regions) throw new Error('.litematic thiếu Regions');
  const regionName = Object.keys(regions)[0];
  const region = regions[regionName]?.value ?? regions[regionName];

  const palette = region.BlockStatePalette?.value ?? region.BlockStatePalette;
  const paletteList = palette?.value ?? palette;
  const nameList = paletteList.map(entry => {
    const e = entry?.value ?? entry;
    const name = (e.Name?.value ?? e.Name ?? 'air').replace(/^minecraft:/, '');
    return name;
  });

  const sizeTag = region.Size?.value ?? region.Size;
  const sizeX = Math.abs(sizeTag.x?.value ?? sizeTag.x ?? 0);
  const sizeY = Math.abs(sizeTag.y?.value ?? sizeTag.y ?? 0);
  const sizeZ = Math.abs(sizeTag.z?.value ?? sizeTag.z ?? 0);
  const volume = sizeX * sizeY * sizeZ;
  if (!volume) throw new Error('.litematic Size = 0');

  const bitsPerEntry = Math.max(2, Math.ceil(Math.log2(nameList.length)));
  const mask = (1n << BigInt(bitsPerEntry)) - 1n;

  const bsRaw = region.BlockStates?.value ?? region.BlockStates;
  const longs = [];
  if (Array.isArray(bsRaw)) {
    for (const entry of bsRaw) {
      if (typeof entry === 'bigint') { longs.push(entry); }
      else if (Array.isArray(entry) && entry.length === 2) {
        longs.push((BigInt(entry[0]) << 32n) | (BigInt(entry[1]) & 0xFFFFFFFFn));
      } else { longs.push(BigInt(entry)); }
    }
  }

  const blocks = [];
  let bitBuffer = 0n, bitsInBuffer = 0, longIdx = 0;

  for (let i = 0; i < volume; i++) {
    while (bitsInBuffer < bitsPerEntry && longIdx < longs.length) {
      bitBuffer |= longs[longIdx++] << BigInt(bitsInBuffer);
      bitsInBuffer += 64;
    }
    const paletteIdx = Number(bitBuffer & mask);
    bitBuffer >>= BigInt(bitsPerEntry);
    bitsInBuffer -= bitsPerEntry;

    const name = nameList[paletteIdx] ?? 'air';
    if (!name || name === 'air') continue;

    const x = i % sizeX;
    const z = Math.floor(i / sizeX) % sizeZ;
    const y = Math.floor(i / (sizeX * sizeZ));
    blocks.push({ x, y, z, blockName: name });
  }
  return blocks;
}

// ── GAME STAGE DETECTION ──────────────────────────────────────────────
function detectGameStage(bot) {
  if (!bot) return 'early';

  let dim = 'overworld';
  try { dim = bot.game?.dimension || 'overworld'; } catch(_){}
  if (dim === 'the_end') {
    const inv0 = bot.inventory?.items() || [];
    if (inv0.some(i => i.name === 'elytra')) return 'end_done';
    return 'pre_end';
  }
  if (dim === 'the_nether') return 'nether';

  const inv = bot.inventory?.items() || [];
  const has  = (substr) => inv.some(i => i.name.includes(substr));
  const count = (substr) => inv.filter(i => i.name.includes(substr)).reduce((s,i)=>s+i.count, 0);
  const hasExact = (name) => inv.some(i => i.name === name);

  if (hasExact('dragon_egg') || hasExact('elytra')) return 'end_done';
  if (has('eye_of_ender') && count('eye_of_ender') >= 3) return 'pre_end';
  if (has('blaze_rod') || has('blaze_powder')) return 'nether';
  if (count('ender_pearl') >= 3) return 'nether';
  if (has('nether_brick') || has('nether_quartz')) return 'nether';
  if (has('diamond_pickaxe') || has('diamond_sword') || count('diamond') >= 3) return 'diamond';
  if (has('iron_pickaxe') || has('iron_sword') || has('iron_chestplate') || count('iron_ingot') >= 5) return 'iron';
  if (has('stone_pickaxe') || has('stone_sword') || count('cobblestone') >= 8) return 'stone';
  if (count('_log') >= 3 || count('_planks') >= 8 || has('wooden_pickaxe') || has('crafting_table')) return 'wood';
  return 'early';
}

// ── TOOL TIER DETECTION ───────────────────────────────────────────────
function getToolTier(bot) {
  if (!bot) return 'tay trần';
  const names = (bot.inventory?.items() || []).map(i => i.name);
  if (names.some(n => n === 'netherite_pickaxe')) return 'netherite';
  if (names.some(n => n === 'diamond_pickaxe')) return 'diamond';
  if (names.some(n => n === 'iron_pickaxe')) return 'iron';
  if (names.some(n => n === 'stone_pickaxe')) return 'stone';
  if (names.some(n => n === 'wooden_pickaxe')) return 'wooden';
  return 'tay trần';
}

// ── ARMOR TIER DETECTION ──────────────────────────────────────────────
function getArmorTier(bot) {
  if (!bot) return 'không có';
  const slots = bot.inventory?.slots || [];
  const worn  = [slots[5],slots[6],slots[7],slots[8]].filter(Boolean).map(i => i.name);
  if (worn.some(n => n.includes('netherite'))) return 'netherite';
  if (worn.some(n => n.includes('diamond')))   return 'diamond';
  if (worn.some(n => n.includes('iron')))      return 'iron';
  if (worn.length > 0)                          return 'leather/gold/chain';
  return 'không có';
}

// ── SHOULD REPLY ──────────────────────────────────────────────────────
function shouldReply(bot, user, msg, configUsername) {
  if (!bot || !user || !user.trim()) return false;
  if (user === bot.username) return false;
  const t = msg.toLowerCase();
  const myName = configUsername.toLowerCase();
  if (t.includes(myName)) return true;
  if (/^(hi|hello|hey|chào|alo)/i.test(t) && t.includes(myName) && msg.length < 60) return true;
  return false;
}

// ── IS FULLY ARMORED ──────────────────────────────────────────────────
function isFullyArmored(bot) {
  if (!bot) return false;
  const s = bot.inventory.slots;
  return !!(s[5] && s[6] && s[7] && s[8]);
}

// ── GET MISSING ARMOR NAMES ───────────────────────────────────────────
function getMissingArmorNames(bot) {
  if (!bot) return ['tất cả'];
  const s = bot.inventory.slots;
  const missing = [];
  if (!s[5]) missing.push('mũ');
  if (!s[6]) missing.push('áo');
  if (!s[7]) missing.push('quần');
  if (!s[8]) missing.push('giày');
  return missing;
}

// ── KEY USAGE TRACKING ────────────────────────────────────────────────
function createKeyUsageTracker() {
  const _keyUsageCount = new Map();
  const _keyRpdExhaustedUntil = new Map();

  function trackKeyUsage(key, role) {
    if (!key) return;
    const today = _getTodayUTC();
    const cur = _keyUsageCount.get(key) || { chat: 0, decision: 0, date: today };
    if (cur.date !== today) { cur.chat = 0; cur.decision = 0; cur.date = today; }
    if (role === 'chat') cur.chat++;
    else if (role === 'decision') cur.decision++;
    _keyUsageCount.set(key, cur);
  }

  function getKeyUsage(key) {
    if (!key) return { chat: 0, decision: 0 };
    const today = _getTodayUTC();
    const cur = _keyUsageCount.get(key);
    if (!cur || cur.date !== today) return { chat: 0, decision: 0 };
    return cur;
  }

  function isKeyRpdExhausted(key) {
    const until = _keyRpdExhaustedUntil.get(key);
    if (!until) return false;
    if (Date.now() >= until) { _keyRpdExhaustedUntil.delete(key); return false; }
    return true;
  }

  function markKeyRpdExhausted(key) {
    const now = new Date();
    const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
    _keyRpdExhaustedUntil.set(key, midnight);
  }

  return { trackKeyUsage, getKeyUsage, isKeyRpdExhausted, markKeyRpdExhausted };
}

// ── INVENTORY FULL CHECK ──────────────────────────────────────────────
function isInventoryFull(bot) {
  let empty = 0;
  for (let i = 9; i < 45; i++) { if (!bot.inventory.slots[i]) empty++; }
  return empty <= 2;
}

module.exports = {
  oreDisplayName,
  shouldKeep,
  makeBar,
  getItemIcon,
  readVarint,
  _isRpdErrorMsg,
  _getTodayUTC,
  parseSpongeSchem,
  parseLitematic,
  detectGameStage,
  getToolTier,
  getArmorTier,
  shouldReply,
  isFullyArmored,
  getMissingArmorNames,
  createKeyUsageTracker,
  isInventoryFull,
  KEEP_ITEMS,
  ORE_NAMES,
  ITEM_ICONS,
};
