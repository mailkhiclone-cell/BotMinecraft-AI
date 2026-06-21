'use strict';

const {
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
} = require('../lib/utils.cjs');

// ══════════════════════════════════════════════════════════════════════
// HELPER: create a mock bot object
// ══════════════════════════════════════════════════════════════════════
function mockBot(overrides = {}) {
  return {
    username: 'TestBot',
    health: 20,
    food: 20,
    entity: { position: { x: 0, y: 64, z: 0, distanceTo: () => 99 } },
    game: { dimension: 'overworld' },
    inventory: {
      items: () => [],
      slots: new Array(46).fill(null),
    },
    ...overrides,
  };
}

// ══════════════════════════════════════════════════════════════════════
// oreDisplayName
// ══════════════════════════════════════════════════════════════════════
describe('oreDisplayName', () => {
  test('returns Vietnamese name for known ore', () => {
    expect(oreDisplayName('diamond_ore')).toBe('Kim cương');
    expect(oreDisplayName('iron_ore')).toBe('Sắt');
    expect(oreDisplayName('coal_ore')).toBe('Than');
    expect(oreDisplayName('gold_ore')).toBe('Vàng');
  });

  test('strips deepslate_ prefix and resolves base name', () => {
    expect(oreDisplayName('deepslate_diamond_ore')).toBe('Kim cương');
    expect(oreDisplayName('deepslate_iron_ore')).toBe('Sắt');
    expect(oreDisplayName('deepslate_gold_ore')).toBe('Vàng');
  });

  test('returns formatted fallback for unknown ore', () => {
    expect(oreDisplayName('ancient_debris')).toBe('ancient debris');
    expect(oreDisplayName('some_block')).toBe('some block');
  });

  test('handles nether ores', () => {
    expect(oreDisplayName('nether_quartz_ore')).toBe('Thạch anh');
    expect(oreDisplayName('nether_gold_ore')).toBe('Vàng địa ngục');
  });
});

// ══════════════════════════════════════════════════════════════════════
// shouldKeep
// ══════════════════════════════════════════════════════════════════════
describe('shouldKeep', () => {
  test('keeps tools and weapons', () => {
    expect(shouldKeep('diamond_pickaxe')).toBe(true);
    expect(shouldKeep('iron_sword')).toBe(true);
    expect(shouldKeep('netherite_axe')).toBe(true);
    expect(shouldKeep('wooden_shovel')).toBe(true);
    expect(shouldKeep('diamond_hoe')).toBe(true);
    expect(shouldKeep('bow')).toBe(true);
    expect(shouldKeep('crossbow')).toBe(true);
    expect(shouldKeep('mace')).toBe(true);
    expect(shouldKeep('trident')).toBe(true);
  });

  test('keeps armor', () => {
    expect(shouldKeep('diamond_helmet')).toBe(true);
    expect(shouldKeep('iron_chestplate')).toBe(true);
    expect(shouldKeep('netherite_leggings')).toBe(true);
    expect(shouldKeep('leather_boots')).toBe(true);
    expect(shouldKeep('shield')).toBe(true);
    expect(shouldKeep('elytra')).toBe(true);
  });

  test('keeps utility items', () => {
    expect(shouldKeep('totem_of_undying')).toBe(true);
    expect(shouldKeep('ender_pearl')).toBe(true);
    expect(shouldKeep('firework_rocket')).toBe(true);
    expect(shouldKeep('water_bucket')).toBe(true);
    expect(shouldKeep('lava_bucket')).toBe(true);
    expect(shouldKeep('golden_apple')).toBe(true);
    expect(shouldKeep('enchanted_golden_apple')).toBe(true);
    expect(shouldKeep('arrow')).toBe(true);
  });

  test('keeps chest', () => {
    expect(shouldKeep('chest')).toBe(true);
  });

  test('does not keep common items', () => {
    expect(shouldKeep('dirt')).toBe(false);
    expect(shouldKeep('cobblestone')).toBe(false);
    expect(shouldKeep('rotten_flesh')).toBe(false);
    expect(shouldKeep('wheat')).toBe(false);
    expect(shouldKeep('oak_log')).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════════════
// makeBar
// ══════════════════════════════════════════════════════════════════════
describe('makeBar', () => {
  test('returns full bar when val equals max', () => {
    expect(makeBar(20, 20)).toBe('██████████');
  });

  test('returns empty bar when val is 0', () => {
    expect(makeBar(0, 20)).toBe('░░░░░░░░░░');
  });

  test('returns half bar for 50%', () => {
    expect(makeBar(10, 20)).toBe('█████░░░░░');
  });

  test('handles val greater than max (clamped)', () => {
    expect(makeBar(30, 20)).toBe('██████████');
  });

  test('handles negative val (clamped to 0)', () => {
    expect(makeBar(-5, 20)).toBe('░░░░░░░░░░');
  });

  test('handles max = 0 gracefully (uses 1 as fallback)', () => {
    // When max=0, formula uses (max||1)=1, so val/1 clamped to [0,1]
    expect(makeBar(5, 0)).toBe('██████████');
    expect(makeBar(0, 0)).toBe('░░░░░░░░░░');
  });

  test('always returns string of length 10', () => {
    for (let i = 0; i <= 20; i++) {
      expect(makeBar(i, 20).length).toBe(10);
    }
  });
});

// ══════════════════════════════════════════════════════════════════════
// getItemIcon
// ══════════════════════════════════════════════════════════════════════
describe('getItemIcon', () => {
  test('returns correct icon for known items', () => {
    expect(getItemIcon('Diamond Sword')).toBe('💎');
    expect(getItemIcon('Iron Ingot')).toBe('⬜');
    expect(getItemIcon('Oak Log')).toBe('🪵');
    expect(getItemIcon('Cooked Beef')).toBe('🥩');
    expect(getItemIcon('Blaze Rod')).toBe('🔥');
    expect(getItemIcon('Ender Pearl')).toBe('💜');
  });

  test('returns default icon for unknown items', () => {
    expect(getItemIcon('Mysterious Artifact')).toBe('📦');
    expect(getItemIcon('')).toBe('📦');
    expect(getItemIcon(null)).toBe('📦');
    expect(getItemIcon(undefined)).toBe('📦');
  });

  test('is case-insensitive', () => {
    expect(getItemIcon('diamond')).toBe('💎');
    expect(getItemIcon('IRON INGOT')).toBe('⬜');
    expect(getItemIcon('cooked beef')).toBe('🥩');
  });
});

// ══════════════════════════════════════════════════════════════════════
// readVarint
// ══════════════════════════════════════════════════════════════════════
describe('readVarint', () => {
  test('reads single-byte varint', () => {
    const buf = Buffer.from([0x01]);
    expect(readVarint(buf, 0)).toEqual({ value: 1, bytesRead: 1 });
  });

  test('reads zero value', () => {
    const buf = Buffer.from([0x00]);
    expect(readVarint(buf, 0)).toEqual({ value: 0, bytesRead: 1 });
  });

  test('reads multi-byte varint (128 = 0x80 0x01)', () => {
    const buf = Buffer.from([0x80, 0x01]);
    expect(readVarint(buf, 0)).toEqual({ value: 128, bytesRead: 2 });
  });

  test('reads varint with offset', () => {
    const buf = Buffer.from([0xFF, 0x05, 0x03]);
    expect(readVarint(buf, 2)).toEqual({ value: 3, bytesRead: 3 });
  });

  test('reads larger varint (300 = 0xAC 0x02)', () => {
    const buf = Buffer.from([0xAC, 0x02]);
    expect(readVarint(buf, 0)).toEqual({ value: 300, bytesRead: 2 });
  });

  test('reads 127 (max single byte)', () => {
    const buf = Buffer.from([0x7F]);
    expect(readVarint(buf, 0)).toEqual({ value: 127, bytesRead: 1 });
  });
});

// ══════════════════════════════════════════════════════════════════════
// _isRpdErrorMsg
// ══════════════════════════════════════════════════════════════════════
describe('_isRpdErrorMsg', () => {
  test('detects quota-related errors', () => {
    expect(_isRpdErrorMsg('Quota exceeded for model')).toBe(true);
    expect(_isRpdErrorMsg('You have exceeded your daily limit')).toBe(true);
    expect(_isRpdErrorMsg('Rate limit per day reached')).toBe(true);
    expect(_isRpdErrorMsg('Daily request limit exceeded')).toBe(true);
  });

  test('returns false for non-RPD errors', () => {
    expect(_isRpdErrorMsg('Connection timeout')).toBe(false);
    expect(_isRpdErrorMsg('Internal server error')).toBe(false);
    expect(_isRpdErrorMsg('Invalid API key')).toBe(false);
    expect(_isRpdErrorMsg('')).toBe(false);
  });

  test('handles null/undefined gracefully', () => {
    expect(_isRpdErrorMsg(null)).toBe(false);
    expect(_isRpdErrorMsg(undefined)).toBe(false);
  });

  test('is case-insensitive', () => {
    expect(_isRpdErrorMsg('QUOTA EXCEEDED')).toBe(true);
    expect(_isRpdErrorMsg('Exceeded Your limit')).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════════
// _getTodayUTC
// ══════════════════════════════════════════════════════════════════════
describe('_getTodayUTC', () => {
  test('returns date in YYYY-MM-DD format', () => {
    const result = _getTodayUTC();
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test('pads single-digit month and day', () => {
    const result = _getTodayUTC();
    const parts = result.split('-');
    expect(parts[1].length).toBe(2);
    expect(parts[2].length).toBe(2);
  });
});

// ══════════════════════════════════════════════════════════════════════
// detectGameStage
// ══════════════════════════════════════════════════════════════════════
describe('detectGameStage', () => {
  test('returns "early" when bot is null', () => {
    expect(detectGameStage(null)).toBe('early');
  });

  test('returns "early" for empty inventory in overworld', () => {
    const bot = mockBot();
    expect(detectGameStage(bot)).toBe('early');
  });

  test('returns "wood" when has logs', () => {
    const bot = mockBot({
      inventory: {
        items: () => [{ name: 'oak_log', count: 5 }],
        slots: new Array(46).fill(null),
      },
    });
    expect(detectGameStage(bot)).toBe('wood');
  });

  test('returns "wood" when has planks', () => {
    const bot = mockBot({
      inventory: {
        items: () => [{ name: 'oak_planks', count: 10 }],
        slots: new Array(46).fill(null),
      },
    });
    expect(detectGameStage(bot)).toBe('wood');
  });

  test('returns "stone" when has stone pickaxe', () => {
    const bot = mockBot({
      inventory: {
        items: () => [{ name: 'stone_pickaxe', count: 1 }],
        slots: new Array(46).fill(null),
      },
    });
    expect(detectGameStage(bot)).toBe('stone');
  });

  test('returns "stone" when has 8+ cobblestone', () => {
    const bot = mockBot({
      inventory: {
        items: () => [{ name: 'cobblestone', count: 10 }],
        slots: new Array(46).fill(null),
      },
    });
    expect(detectGameStage(bot)).toBe('stone');
  });

  test('returns "iron" when has iron pickaxe', () => {
    const bot = mockBot({
      inventory: {
        items: () => [{ name: 'iron_pickaxe', count: 1 }],
        slots: new Array(46).fill(null),
      },
    });
    expect(detectGameStage(bot)).toBe('iron');
  });

  test('returns "iron" when has 5+ iron ingots', () => {
    const bot = mockBot({
      inventory: {
        items: () => [{ name: 'iron_ingot', count: 5 }],
        slots: new Array(46).fill(null),
      },
    });
    expect(detectGameStage(bot)).toBe('iron');
  });

  test('returns "diamond" when has diamond pickaxe', () => {
    const bot = mockBot({
      inventory: {
        items: () => [{ name: 'diamond_pickaxe', count: 1 }],
        slots: new Array(46).fill(null),
      },
    });
    expect(detectGameStage(bot)).toBe('diamond');
  });

  test('returns "diamond" when has 3+ diamonds', () => {
    const bot = mockBot({
      inventory: {
        items: () => [{ name: 'diamond', count: 3 }],
        slots: new Array(46).fill(null),
      },
    });
    expect(detectGameStage(bot)).toBe('diamond');
  });

  test('returns "nether" when has blaze rod', () => {
    const bot = mockBot({
      inventory: {
        items: () => [{ name: 'blaze_rod', count: 1 }],
        slots: new Array(46).fill(null),
      },
    });
    expect(detectGameStage(bot)).toBe('nether');
  });

  test('returns "nether" when in the_nether dimension', () => {
    const bot = mockBot({
      game: { dimension: 'the_nether' },
    });
    expect(detectGameStage(bot)).toBe('nether');
  });

  test('returns "pre_end" when has 3+ eye of ender', () => {
    const bot = mockBot({
      inventory: {
        items: () => [{ name: 'eye_of_ender', count: 5 }],
        slots: new Array(46).fill(null),
      },
    });
    expect(detectGameStage(bot)).toBe('pre_end');
  });

  test('returns "pre_end" when in the_end without elytra', () => {
    const bot = mockBot({
      game: { dimension: 'the_end' },
      inventory: {
        items: () => [],
        slots: new Array(46).fill(null),
      },
    });
    expect(detectGameStage(bot)).toBe('pre_end');
  });

  test('returns "end_done" when has elytra', () => {
    const bot = mockBot({
      inventory: {
        items: () => [{ name: 'elytra', count: 1 }],
        slots: new Array(46).fill(null),
      },
    });
    expect(detectGameStage(bot)).toBe('end_done');
  });

  test('returns "end_done" when in the_end with elytra', () => {
    const bot = mockBot({
      game: { dimension: 'the_end' },
      inventory: {
        items: () => [{ name: 'elytra', count: 1 }],
        slots: new Array(46).fill(null),
      },
    });
    expect(detectGameStage(bot)).toBe('end_done');
  });

  test('returns "end_done" when has dragon_egg', () => {
    const bot = mockBot({
      inventory: {
        items: () => [{ name: 'dragon_egg', count: 1 }],
        slots: new Array(46).fill(null),
      },
    });
    expect(detectGameStage(bot)).toBe('end_done');
  });
});

// ══════════════════════════════════════════════════════════════════════
// getToolTier
// ══════════════════════════════════════════════════════════════════════
describe('getToolTier', () => {
  test('returns "tay trần" when bot is null', () => {
    expect(getToolTier(null)).toBe('tay trần');
  });

  test('returns "tay trần" with empty inventory', () => {
    const bot = mockBot();
    expect(getToolTier(bot)).toBe('tay trần');
  });

  test('returns "wooden" with wooden pickaxe', () => {
    const bot = mockBot({
      inventory: {
        items: () => [{ name: 'wooden_pickaxe' }],
        slots: new Array(46).fill(null),
      },
    });
    expect(getToolTier(bot)).toBe('wooden');
  });

  test('returns "stone" with stone pickaxe', () => {
    const bot = mockBot({
      inventory: {
        items: () => [{ name: 'stone_pickaxe' }],
        slots: new Array(46).fill(null),
      },
    });
    expect(getToolTier(bot)).toBe('stone');
  });

  test('returns "iron" with iron pickaxe', () => {
    const bot = mockBot({
      inventory: {
        items: () => [{ name: 'iron_pickaxe' }],
        slots: new Array(46).fill(null),
      },
    });
    expect(getToolTier(bot)).toBe('iron');
  });

  test('returns "diamond" with diamond pickaxe', () => {
    const bot = mockBot({
      inventory: {
        items: () => [{ name: 'diamond_pickaxe' }],
        slots: new Array(46).fill(null),
      },
    });
    expect(getToolTier(bot)).toBe('diamond');
  });

  test('returns "netherite" with netherite pickaxe', () => {
    const bot = mockBot({
      inventory: {
        items: () => [{ name: 'netherite_pickaxe' }],
        slots: new Array(46).fill(null),
      },
    });
    expect(getToolTier(bot)).toBe('netherite');
  });

  test('returns highest tier when multiple pickaxes present', () => {
    const bot = mockBot({
      inventory: {
        items: () => [
          { name: 'wooden_pickaxe' },
          { name: 'diamond_pickaxe' },
          { name: 'iron_pickaxe' },
        ],
        slots: new Array(46).fill(null),
      },
    });
    expect(getToolTier(bot)).toBe('diamond');
  });
});

// ══════════════════════════════════════════════════════════════════════
// getArmorTier
// ══════════════════════════════════════════════════════════════════════
describe('getArmorTier', () => {
  test('returns "không có" when bot is null', () => {
    expect(getArmorTier(null)).toBe('không có');
  });

  test('returns "không có" when no armor equipped', () => {
    const bot = mockBot();
    expect(getArmorTier(bot)).toBe('không có');
  });

  test('returns "iron" with iron armor', () => {
    const slots = new Array(46).fill(null);
    slots[5] = { name: 'iron_helmet' };
    slots[6] = { name: 'iron_chestplate' };
    slots[7] = { name: 'iron_leggings' };
    slots[8] = { name: 'iron_boots' };
    const bot = mockBot({ inventory: { items: () => [], slots } });
    expect(getArmorTier(bot)).toBe('iron');
  });

  test('returns "diamond" with diamond armor', () => {
    const slots = new Array(46).fill(null);
    slots[5] = { name: 'diamond_helmet' };
    slots[6] = { name: 'diamond_chestplate' };
    const bot = mockBot({ inventory: { items: () => [], slots } });
    expect(getArmorTier(bot)).toBe('diamond');
  });

  test('returns "netherite" with netherite armor', () => {
    const slots = new Array(46).fill(null);
    slots[5] = { name: 'netherite_helmet' };
    const bot = mockBot({ inventory: { items: () => [], slots } });
    expect(getArmorTier(bot)).toBe('netherite');
  });

  test('returns "leather/gold/chain" for leather armor', () => {
    const slots = new Array(46).fill(null);
    slots[5] = { name: 'leather_helmet' };
    const bot = mockBot({ inventory: { items: () => [], slots } });
    expect(getArmorTier(bot)).toBe('leather/gold/chain');
  });

  test('returns highest tier from mixed armor', () => {
    const slots = new Array(46).fill(null);
    slots[5] = { name: 'iron_helmet' };
    slots[6] = { name: 'diamond_chestplate' };
    slots[7] = { name: 'leather_leggings' };
    slots[8] = { name: 'iron_boots' };
    const bot = mockBot({ inventory: { items: () => [], slots } });
    expect(getArmorTier(bot)).toBe('diamond');
  });
});

// ══════════════════════════════════════════════════════════════════════
// shouldReply
// ══════════════════════════════════════════════════════════════════════
describe('shouldReply', () => {
  const bot = mockBot();
  const configUsername = 'KhanhKhi';

  test('returns false when bot is null', () => {
    expect(shouldReply(null, 'Player', 'hello KhanhKhi', configUsername)).toBe(false);
  });

  test('returns false when user is empty', () => {
    expect(shouldReply(bot, '', 'hello KhanhKhi', configUsername)).toBe(false);
    expect(shouldReply(bot, '   ', 'hello KhanhKhi', configUsername)).toBe(false);
  });

  test('returns false when user is the bot itself', () => {
    expect(shouldReply(bot, 'TestBot', 'some message', configUsername)).toBe(false);
  });

  test('returns true when message contains bot name', () => {
    expect(shouldReply(bot, 'Player1', 'hey khanhkhi how are you', configUsername)).toBe(true);
  });

  test('returns true for greeting with bot name', () => {
    expect(shouldReply(bot, 'Player1', 'hello khanhkhi', configUsername)).toBe(true);
    expect(shouldReply(bot, 'Player1', 'hi khanhkhi', configUsername)).toBe(true);
    expect(shouldReply(bot, 'Player1', 'hey khanhkhi', configUsername)).toBe(true);
    expect(shouldReply(bot, 'Player1', 'chào khanhkhi', configUsername)).toBe(true);
  });

  test('returns false when message does not contain bot name', () => {
    expect(shouldReply(bot, 'Player1', 'hello everyone', configUsername)).toBe(false);
    expect(shouldReply(bot, 'Player1', 'nice weather today', configUsername)).toBe(false);
  });

  test('is case-insensitive for bot name matching', () => {
    expect(shouldReply(bot, 'Player1', 'KHANHKHI come here', configUsername)).toBe(true);
    expect(shouldReply(bot, 'Player1', 'KhAnHkHi what?', configUsername)).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════════
// isFullyArmored
// ══════════════════════════════════════════════════════════════════════
describe('isFullyArmored', () => {
  test('returns false when bot is null', () => {
    expect(isFullyArmored(null)).toBe(false);
  });

  test('returns false with no armor', () => {
    const bot = mockBot();
    expect(isFullyArmored(bot)).toBe(false);
  });

  test('returns true with all slots filled', () => {
    const slots = new Array(46).fill(null);
    slots[5] = { name: 'iron_helmet' };
    slots[6] = { name: 'iron_chestplate' };
    slots[7] = { name: 'iron_leggings' };
    slots[8] = { name: 'iron_boots' };
    const bot = mockBot({ inventory: { items: () => [], slots } });
    expect(isFullyArmored(bot)).toBe(true);
  });

  test('returns false with partial armor', () => {
    const slots = new Array(46).fill(null);
    slots[5] = { name: 'iron_helmet' };
    slots[6] = { name: 'iron_chestplate' };
    const bot = mockBot({ inventory: { items: () => [], slots } });
    expect(isFullyArmored(bot)).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════════════
// getMissingArmorNames
// ══════════════════════════════════════════════════════════════════════
describe('getMissingArmorNames', () => {
  test('returns ["tất cả"] when bot is null', () => {
    expect(getMissingArmorNames(null)).toEqual(['tất cả']);
  });

  test('returns all pieces when fully unarmored', () => {
    const bot = mockBot();
    expect(getMissingArmorNames(bot)).toEqual(['mũ', 'áo', 'quần', 'giày']);
  });

  test('returns empty array when fully armored', () => {
    const slots = new Array(46).fill(null);
    slots[5] = { name: 'iron_helmet' };
    slots[6] = { name: 'iron_chestplate' };
    slots[7] = { name: 'iron_leggings' };
    slots[8] = { name: 'iron_boots' };
    const bot = mockBot({ inventory: { items: () => [], slots } });
    expect(getMissingArmorNames(bot)).toEqual([]);
  });

  test('returns missing pieces only', () => {
    const slots = new Array(46).fill(null);
    slots[5] = { name: 'iron_helmet' };
    slots[8] = { name: 'iron_boots' };
    const bot = mockBot({ inventory: { items: () => [], slots } });
    expect(getMissingArmorNames(bot)).toEqual(['áo', 'quần']);
  });
});

// ══════════════════════════════════════════════════════════════════════
// createKeyUsageTracker
// ══════════════════════════════════════════════════════════════════════
describe('createKeyUsageTracker', () => {
  test('tracks chat key usage', () => {
    const tracker = createKeyUsageTracker();
    tracker.trackKeyUsage('key1', 'chat');
    tracker.trackKeyUsage('key1', 'chat');
    const usage = tracker.getKeyUsage('key1');
    expect(usage.chat).toBe(2);
    expect(usage.decision).toBe(0);
  });

  test('tracks decision key usage', () => {
    const tracker = createKeyUsageTracker();
    tracker.trackKeyUsage('key1', 'decision');
    const usage = tracker.getKeyUsage('key1');
    expect(usage.chat).toBe(0);
    expect(usage.decision).toBe(1);
  });

  test('returns zeros for unknown key', () => {
    const tracker = createKeyUsageTracker();
    const usage = tracker.getKeyUsage('unknown_key');
    expect(usage.chat).toBe(0);
    expect(usage.decision).toBe(0);
  });

  test('returns zeros for empty key', () => {
    const tracker = createKeyUsageTracker();
    expect(tracker.getKeyUsage('')).toEqual({ chat: 0, decision: 0 });
    expect(tracker.getKeyUsage(null)).toEqual({ chat: 0, decision: 0 });
  });

  test('isKeyRpdExhausted returns false for unknown key', () => {
    const tracker = createKeyUsageTracker();
    expect(tracker.isKeyRpdExhausted('key1')).toBe(false);
  });

  test('markKeyRpdExhausted marks key as exhausted', () => {
    const tracker = createKeyUsageTracker();
    tracker.markKeyRpdExhausted('key1');
    expect(tracker.isKeyRpdExhausted('key1')).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════════
// isInventoryFull
// ══════════════════════════════════════════════════════════════════════
describe('isInventoryFull', () => {
  test('returns true when only 2 slots empty', () => {
    const slots = new Array(46).fill({ name: 'stone' });
    slots[9] = null;
    slots[10] = null;
    const bot = mockBot({ inventory: { items: () => [], slots } });
    expect(isInventoryFull(bot)).toBe(true);
  });

  test('returns true when 0 slots empty', () => {
    const slots = new Array(46).fill({ name: 'stone' });
    const bot = mockBot({ inventory: { items: () => [], slots } });
    expect(isInventoryFull(bot)).toBe(true);
  });

  test('returns false when many slots empty', () => {
    const slots = new Array(46).fill(null);
    const bot = mockBot({ inventory: { items: () => [], slots } });
    expect(isInventoryFull(bot)).toBe(false);
  });

  test('returns false when 3 slots empty', () => {
    const slots = new Array(46).fill({ name: 'stone' });
    slots[9] = null;
    slots[10] = null;
    slots[11] = null;
    const bot = mockBot({ inventory: { items: () => [], slots } });
    expect(isInventoryFull(bot)).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════════════
// parseSpongeSchem
// ══════════════════════════════════════════════════════════════════════
describe('parseSpongeSchem', () => {
  test('parses a simple 2x2x2 schematic', () => {
    const root = {
      Width: 2,
      Height: 2,
      Length: 2,
      Palette: {
        'minecraft:air': 0,
        'minecraft:stone': 1,
        'minecraft:dirt': 2,
      },
      BlockData: {
        value: Buffer.from([
          0, 1, 2, 1,  // layer y=0: (0,0,0)=air, (1,0,0)=stone, (0,0,1)=dirt, (1,0,1)=stone
          1, 2, 1, 0,  // layer y=1: (0,1,0)=stone, (1,1,0)=dirt, (0,1,1)=stone, (1,1,1)=air
        ]),
      },
    };
    const blocks = parseSpongeSchem(root);
    // Should exclude air blocks
    expect(blocks.length).toBe(6);
    expect(blocks).toContainEqual({ x: 1, y: 0, z: 0, blockName: 'stone' });
    expect(blocks).toContainEqual({ x: 0, y: 0, z: 1, blockName: 'dirt' });
  });

  test('throws on missing dimensions', () => {
    expect(() => parseSpongeSchem({ Width: 0, Height: 2, Length: 2, Palette: {}, BlockData: { value: Buffer.from([]) } }))
      .toThrow('Sponge schem thiếu Width/Height/Length');
  });

  test('strips minecraft: prefix and block states from palette', () => {
    const root = {
      Width: 1,
      Height: 1,
      Length: 1,
      Palette: {
        'minecraft:oak_stairs[facing=east,half=bottom]': 0,
      },
      BlockData: { value: Buffer.from([0]) },
    };
    const blocks = parseSpongeSchem(root);
    expect(blocks[0].blockName).toBe('oak_stairs');
  });

  test('handles NBT-wrapped values', () => {
    const root = {
      Width: { value: 1 },
      Height: { value: 1 },
      Length: { value: 1 },
      Palette: { value: { 'minecraft:glass': { type: 'int', value: 0 } } },
      BlockData: { value: Buffer.from([0]) },
    };
    const blocks = parseSpongeSchem(root);
    expect(blocks[0].blockName).toBe('glass');
  });
});

// ══════════════════════════════════════════════════════════════════════
// parseLitematic
// ══════════════════════════════════════════════════════════════════════
describe('parseLitematic', () => {
  test('throws on missing Regions', () => {
    expect(() => parseLitematic({})).toThrow('.litematic thiếu Regions');
  });

  test('throws on zero size', () => {
    const root = {
      Regions: {
        TestRegion: {
          BlockStatePalette: [
            { Name: 'minecraft:air' },
            { Name: 'minecraft:stone' },
          ],
          Size: { x: 0, y: 0, z: 0 },
          BlockStates: [],
        },
      },
    };
    expect(() => parseLitematic(root)).toThrow('.litematic Size = 0');
  });

  test('parses a simple 2x1x1 litematic', () => {
    // 2 palette entries → bitsPerEntry = max(2, ceil(log2(2))) = 2
    // Volume = 2*1*1 = 2 blocks
    // Block indices: [1, 0] → stone, air
    // Packed into one long: bits = 01 00 = index1=1, index0=0 → wait no
    // Actually: for i=0 => paletteIdx from bits, i=1 => next bits
    // Let's pack: index 0 = 1 (stone), index 1 = 0 (air)
    // With 2 bits per entry: binary = ...00 01 → 0b0001 = 1n for first long
    // Actually: LSB first: entry[0] = 1 (bits: 01), entry[1] = 0 (bits: 00)
    // Combined: 0b0001 = 1n? No: 01 | (00 << 2) = 0b0001 = 1n
    const root = {
      Regions: {
        TestRegion: {
          BlockStatePalette: [
            { Name: 'minecraft:air' },
            { Name: 'minecraft:stone' },
          ],
          Size: { x: 2, y: 1, z: 1 },
          BlockStates: [1n], // bits: ...0001 → entry[0]=1(stone), entry[1]=0(air)
        },
      },
    };
    const blocks = parseLitematic(root);
    expect(blocks.length).toBe(1);
    expect(blocks[0]).toEqual({ x: 0, y: 0, z: 0, blockName: 'stone' });
  });
});
