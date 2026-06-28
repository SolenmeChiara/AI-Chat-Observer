
import Dexie, { Table } from 'dexie';
import { Agent, ApiProvider, ChatSession, ChatGroup, GlobalSettings } from '../types';
import { INITIAL_AGENTS, INITIAL_PROVIDERS, INITIAL_SESSIONS, INITIAL_GROUPS, DEFAULT_SETTINGS } from '../constants';

class AIObserverDB extends Dexie {
  agents!: Table<Agent>;
  providers!: Table<ApiProvider>;
  sessions!: Table<ChatSession>;
  groups!: Table<ChatGroup>;
  settings!: Table<any>; // Using 'any' to wrap GlobalSettings with an ID

  constructor() {
    super('AIObserverDB');

    // Version 1: Original schema
    (this as any).version(1).stores({
      agents: 'id',
      providers: 'id',
      sessions: 'id',
      settings: 'id'
    });

    // Version 2: Add groups table and migrate existing sessions
    (this as any).version(2).stores({
      agents: 'id',
      providers: 'id',
      sessions: 'id',
      groups: 'id',
      settings: 'id'
    }).upgrade(async (tx: any) => {
      // 迁移：为每个现有session创建一个同名group
      const sessions = await tx.table('sessions').toArray();
      const agents = await tx.table('agents').toArray();
      const activeAgentIds = agents.filter((a: Agent) => a.isActive !== false).map((a: Agent) => a.id);

      for (const session of sessions) {
        if (!session.groupId) {
          const groupId = `group-${session.id}`;
          // 创建群组
          await tx.table('groups').add({
            id: groupId,
            name: session.name || 'Unnamed Group',
            memberIds: session.memberIds || activeAgentIds,
            scenario: session.scenario || '',
            memoryConfig: session.memoryConfig || {
              enabled: false,
              threshold: 20,
              summaryModelId: '',
              summaryProviderId: ''
            },
            createdAt: session.lastUpdated || Date.now()
          });
          // 更新session的groupId
          await tx.table('sessions').update(session.id, {
            groupId: groupId,
            name: '对话 1'
          });
        }
      }
    });
  }
}

const db = new AIObserverDB();

db.on('blocked', () => {
  console.warn('Database upgrade blocked — another tab is holding an older connection. Close other tabs and retry.');
});

// Initialize DB with default data if empty
export const initDB = async () => {
  try {
    const agentCount = await db.agents.count();
    if (agentCount === 0) {
      await (db as any).transaction('rw', db.agents, db.providers, db.sessions, db.groups, db.settings, async () => {
        await db.agents.bulkPut(INITIAL_AGENTS);
        await db.providers.bulkPut(INITIAL_PROVIDERS);
        await db.groups.bulkPut(INITIAL_GROUPS);
        await db.sessions.bulkPut(INITIAL_SESSIONS);
        await db.settings.put({ id: 'global', ...DEFAULT_SETTINGS });
      });
      console.log('Database initialized with default data');
    }
  } catch (err) {
    console.warn('initDB failed (corrupt DB?), will try loading with defaults:', err);
  }
};

export const loadAllData = async () => {
  const safeLoad = async <T>(fn: () => Promise<T>, fallback: T, label: string): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      console.error(`Failed to load ${label}, using defaults:`, err);
      return fallback;
    }
  };

  const agents = await safeLoad(() => db.agents.toArray(), [], 'agents');
  const providers = await safeLoad(() => db.providers.toArray(), [], 'providers');
  const sessions = await safeLoad(() => db.sessions.toArray(), [], 'sessions');
  const groups = await safeLoad(() => db.groups.toArray(), [], 'groups');
  const settingsRecord = await safeLoad(() => db.settings.get('global'), null, 'settings');

  let loadedSettings = DEFAULT_SETTINGS;
  if (settingsRecord) {
      const { id, ...rest } = settingsRecord;
      loadedSettings = rest as GlobalSettings;
  }

  return {
    agents: agents.length ? agents : INITIAL_AGENTS,
    providers: providers.length ? providers : INITIAL_PROVIDERS,
    groups: groups.length ? groups : INITIAL_GROUPS,
    sessions: sessions.length ? sessions : INITIAL_SESSIONS,
    settings: loadedSettings
  };
};

// Generic helper to sync a collection (React State -> DB)
// We use clear() + bulkPut() inside a transaction to ensure deleted items in state are removed from DB
export const saveCollection = async <T extends { id: string }>(tableName: 'agents' | 'providers' | 'sessions' | 'groups', items: T[]) => {
  if (items.length === 0) {
    console.warn(`saveCollection('${tableName}'): refusing to save empty array (would delete all data)`);
    return;
  }
  try {
    const table = (db as any).table(tableName);
    await (db as any).transaction('rw', table, async () => {
       await table.clear();
       await table.bulkPut(items);
    });
  } catch (err) {
    console.error(`Failed to save ${tableName}`, err);
  }
};

export const saveSettings = async (settings: GlobalSettings) => {
  try {
    // Explicitly destructure to remove any potential 'id' from the settings object
    // to ensure we don't write id: undefined to the DB.
    const { id, ...rest } = settings as any;
    await db.settings.put({ id: 'global', ...rest });
  } catch (err) {
    console.error('Failed to save settings', err);
  }
};
