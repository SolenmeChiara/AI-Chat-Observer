
// Entertainment Service: Dice Rolling and Tarot Cards

// ============ DICE SYSTEM ============

export interface DiceResult {
  expression: string;      // Original expression like "2d6+3"
  rolls: number[];         // Individual die results
  modifier: number;        // +/- modifier
  total: number;           // Final result
  breakdown: string;       // Human readable like "2d6+3 = 11 (4+5+2)"
}

/**
 * Parse and roll dice expression
 * Supports: d20, 2d6, d6+3, 2d8-1, 3d10+5, etc.
 */
export const rollDice = (expression: string): DiceResult | null => {
  // Normalize expression
  const expr = expression.toLowerCase().trim();

  // Match patterns like: d20, 2d6, d6+3, 2d8-1
  const match = expr.match(/^(\d*)d(\d+)([+-]\d+)?$/);
  if (!match) return null;

  const count = match[1] ? parseInt(match[1]) : 1;  // Default 1 die
  const sides = parseInt(match[2]);
  const modifier = match[3] ? parseInt(match[3]) : 0;

  // Sanity checks
  if (count < 1 || count > 100) return null;  // Max 100 dice
  if (sides < 2 || sides > 1000) return null;  // d2 to d1000

  // Roll the dice
  const rolls: number[] = [];
  for (let i = 0; i < count; i++) {
    rolls.push(Math.floor(Math.random() * sides) + 1);
  }

  const sum = rolls.reduce((a, b) => a + b, 0);
  const total = sum + modifier;

  // Build breakdown string
  let breakdown = `${count}d${sides}`;
  if (modifier !== 0) {
    breakdown += modifier > 0 ? `+${modifier}` : `${modifier}`;
  }
  breakdown += ` = ${total}`;
  if (count > 1 || modifier !== 0) {
    breakdown += ` (${rolls.join('+')}`;
    if (modifier !== 0) {
      breakdown += modifier > 0 ? `+${modifier}` : `${modifier}`;
    }
    breakdown += ')';
  }

  return {
    expression: expr,
    rolls,
    modifier,
    total,
    breakdown
  };
};

// ============ TAROT SYSTEM ============

// Major Arcana (大阿卡纳) - 22 张
const MAJOR_ARCANA = [
  { id: 0, name: '愚者', nameEn: 'The Fool', suit: 'major' },
  { id: 1, name: '魔术师', nameEn: 'The Magician', suit: 'major' },
  { id: 2, name: '女祭司', nameEn: 'The High Priestess', suit: 'major' },
  { id: 3, name: '女皇', nameEn: 'The Empress', suit: 'major' },
  { id: 4, name: '皇帝', nameEn: 'The Emperor', suit: 'major' },
  { id: 5, name: '教皇', nameEn: 'The Hierophant', suit: 'major' },
  { id: 6, name: '恋人', nameEn: 'The Lovers', suit: 'major' },
  { id: 7, name: '战车', nameEn: 'The Chariot', suit: 'major' },
  { id: 8, name: '力量', nameEn: 'Strength', suit: 'major' },
  { id: 9, name: '隐士', nameEn: 'The Hermit', suit: 'major' },
  { id: 10, name: '命运之轮', nameEn: 'Wheel of Fortune', suit: 'major' },
  { id: 11, name: '正义', nameEn: 'Justice', suit: 'major' },
  { id: 12, name: '倒吊人', nameEn: 'The Hanged Man', suit: 'major' },
  { id: 13, name: '死神', nameEn: 'Death', suit: 'major' },
  { id: 14, name: '节制', nameEn: 'Temperance', suit: 'major' },
  { id: 15, name: '恶魔', nameEn: 'The Devil', suit: 'major' },
  { id: 16, name: '塔', nameEn: 'The Tower', suit: 'major' },
  { id: 17, name: '星星', nameEn: 'The Star', suit: 'major' },
  { id: 18, name: '月亮', nameEn: 'The Moon', suit: 'major' },
  { id: 19, name: '太阳', nameEn: 'The Sun', suit: 'major' },
  { id: 20, name: '审判', nameEn: 'Judgement', suit: 'major' },
  { id: 21, name: '世界', nameEn: 'The World', suit: 'major' }
];

// Minor Arcana (小阿卡纳) - 56 张
const SUITS = [
  { id: 'wands', name: '权杖', nameEn: 'Wands', symbol: '🪄' },
  { id: 'cups', name: '圣杯', nameEn: 'Cups', symbol: '🏆' },
  { id: 'swords', name: '宝剑', nameEn: 'Swords', symbol: '⚔️' },
  { id: 'pentacles', name: '星币', nameEn: 'Pentacles', symbol: '⭐' }
];

const RANKS = [
  { rank: 1, name: '王牌', nameEn: 'Ace' },
  { rank: 2, name: '二', nameEn: 'Two' },
  { rank: 3, name: '三', nameEn: 'Three' },
  { rank: 4, name: '四', nameEn: 'Four' },
  { rank: 5, name: '五', nameEn: 'Five' },
  { rank: 6, name: '六', nameEn: 'Six' },
  { rank: 7, name: '七', nameEn: 'Seven' },
  { rank: 8, name: '八', nameEn: 'Eight' },
  { rank: 9, name: '九', nameEn: 'Nine' },
  { rank: 10, name: '十', nameEn: 'Ten' },
  { rank: 11, name: '侍从', nameEn: 'Page' },
  { rank: 12, name: '骑士', nameEn: 'Knight' },
  { rank: 13, name: '王后', nameEn: 'Queen' },
  { rank: 14, name: '国王', nameEn: 'King' }
];

// Generate Minor Arcana cards
const MINOR_ARCANA = SUITS.flatMap((suit, suitIdx) =>
  RANKS.map((rank, rankIdx) => ({
    id: 22 + suitIdx * 14 + rankIdx,
    name: `${suit.name}${rank.name}`,
    nameEn: `${rank.nameEn} of ${suit.nameEn}`,
    suit: suit.id
  }))
);

// Full 78-card deck
const FULL_DECK = [...MAJOR_ARCANA, ...MINOR_ARCANA];

export interface TarotCard {
  id: number;
  name: string;
  nameEn: string;
  suit: string;       // 'major' | 'wands' | 'cups' | 'swords' | 'pentacles'
  isReversed: boolean;  // 逆位
}

export interface TarotResult {
  cards: TarotCard[];
  summary: string;  // Human readable summary
}

/**
 * Draw tarot cards from full 78-card deck
 * @param count Number of cards to draw (1-22)
 */
export const drawTarot = (count: number): TarotResult | null => {
  // Sanity check
  if (count < 1 || count > 22) return null;
  if (count > FULL_DECK.length) count = FULL_DECK.length;

  // Shuffle and pick cards (without replacement)
  const deck = [...FULL_DECK];
  const cards: TarotCard[] = [];

  for (let i = 0; i < count; i++) {
    const index = Math.floor(Math.random() * deck.length);
    const card = deck.splice(index, 1)[0];
    const isReversed = Math.random() < 0.5;  // 50% chance reversed

    cards.push({
      ...card,
      isReversed
    });
  }

  // Build summary with suit indicator for minor arcana
  const cardStrings = cards.map(c => {
    const position = c.isReversed ? '逆位' : '正位';
    const isMajor = c.suit === 'major';
    return isMajor ? `【${c.name}】${position}` : `【${c.name}】${position}`;
  });

  let summary: string;
  if (count === 1) {
    summary = `🃏 抽取塔罗牌: ${cardStrings[0]}`;
  } else {
    summary = `🃏 抽取 ${count} 张塔罗牌:\n` + cardStrings.map((s, i) => `  ${i + 1}. ${s}`).join('\n');
  }

  return { cards, summary };
};

// ============ COMMAND PARSING ============

/**
 * Parse entertainment commands from text
 * Returns null if no command found
 */
export interface EntertainmentCommand {
  type: 'dice' | 'tarot';
  result: DiceResult | TarotResult;
  originalMatch: string;
}

export const parseEntertainmentCommands = (
  text: string,
  enableDice: boolean,
  enableTarot: boolean
): EntertainmentCommand[] => {
  const commands: EntertainmentCommand[] = [];

  // Parse dice commands: {{ROLL: 2d6+3}}
  if (enableDice) {
    const diceMatches = text.matchAll(/\{\{ROLL:\s*([^}]+)\}\}/gi);
    for (const match of diceMatches) {
      const result = rollDice(match[1].trim());
      if (result) {
        commands.push({
          type: 'dice',
          result,
          originalMatch: match[0]
        });
      }
    }
  }

  // Parse tarot commands: {{TAROT: 3}} or {{TAROT}}
  if (enableTarot) {
    const tarotMatches = text.matchAll(/\{\{TAROT(?::\s*(\d+))?\}\}/gi);
    for (const match of tarotMatches) {
      const count = match[1] ? parseInt(match[1]) : 1;
      const result = drawTarot(count);
      if (result) {
        commands.push({
          type: 'tarot',
          result,
          originalMatch: match[0]
        });
      }
    }
  }

  return commands;
};

/**
 * Format entertainment results as system message
 */
export const formatEntertainmentMessage = (commands: EntertainmentCommand[]): string => {
  const parts: string[] = [];

  for (const cmd of commands) {
    if (cmd.type === 'dice') {
      const dice = cmd.result as DiceResult;
      parts.push(`🎲 ${dice.breakdown}`);
    } else if (cmd.type === 'tarot') {
      const tarot = cmd.result as TarotResult;
      parts.push(`🃏 ${tarot.summary}`);
    }
  }

  return parts.join('\n\n');
};
