
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

// Major Arcana (大阿卡纳)
const MAJOR_ARCANA = [
  { id: 0, name: '愚者', nameEn: 'The Fool' },
  { id: 1, name: '魔术师', nameEn: 'The Magician' },
  { id: 2, name: '女祭司', nameEn: 'The High Priestess' },
  { id: 3, name: '女皇', nameEn: 'The Empress' },
  { id: 4, name: '皇帝', nameEn: 'The Emperor' },
  { id: 5, name: '教皇', nameEn: 'The Hierophant' },
  { id: 6, name: '恋人', nameEn: 'The Lovers' },
  { id: 7, name: '战车', nameEn: 'The Chariot' },
  { id: 8, name: '力量', nameEn: 'Strength' },
  { id: 9, name: '隐士', nameEn: 'The Hermit' },
  { id: 10, name: '命运之轮', nameEn: 'Wheel of Fortune' },
  { id: 11, name: '正义', nameEn: 'Justice' },
  { id: 12, name: '倒吊人', nameEn: 'The Hanged Man' },
  { id: 13, name: '死神', nameEn: 'Death' },
  { id: 14, name: '节制', nameEn: 'Temperance' },
  { id: 15, name: '恶魔', nameEn: 'The Devil' },
  { id: 16, name: '塔', nameEn: 'The Tower' },
  { id: 17, name: '星星', nameEn: 'The Star' },
  { id: 18, name: '月亮', nameEn: 'The Moon' },
  { id: 19, name: '太阳', nameEn: 'The Sun' },
  { id: 20, name: '审判', nameEn: 'Judgement' },
  { id: 21, name: '世界', nameEn: 'The World' }
];

export interface TarotCard {
  id: number;
  name: string;
  nameEn: string;
  isReversed: boolean;  // 逆位
}

export interface TarotResult {
  cards: TarotCard[];
  summary: string;  // Human readable summary
}

/**
 * Draw tarot cards
 * @param count Number of cards to draw (1-10)
 */
export const drawTarot = (count: number): TarotResult | null => {
  // Sanity check
  if (count < 1 || count > 10) return null;
  if (count > MAJOR_ARCANA.length) count = MAJOR_ARCANA.length;

  // Shuffle and pick cards (without replacement)
  const deck = [...MAJOR_ARCANA];
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

  // Build summary
  const cardStrings = cards.map(c => {
    const position = c.isReversed ? '逆位' : '正位';
    return `【${c.name}】${position}`;
  });

  let summary: string;
  if (count === 1) {
    summary = `抽取塔罗牌: ${cardStrings[0]}`;
  } else if (count === 3) {
    summary = `塔罗三牌阵:\n` +
      `  过去: ${cardStrings[0]}\n` +
      `  现在: ${cardStrings[1]}\n` +
      `  未来: ${cardStrings[2]}`;
  } else {
    summary = `抽取 ${count} 张塔罗牌:\n` + cardStrings.map((s, i) => `  ${i + 1}. ${s}`).join('\n');
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
