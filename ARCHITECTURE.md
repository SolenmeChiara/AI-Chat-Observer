# Project Architecture

This document describes in detail the code structure, data flow, and design philosophy of **AI Chat Observer (V5.5)**. It is intended to help developers quickly understand the system and provide guidance for future integration of **Vector DB**, **Long-term Memory**, or **Backend Services**.

**V5.5 New Features:**
- Private Message (PM) system: Both AI and humans can send PMs, visible only to the target member and the human user
- Dual output: AI can send a public message + PM simultaneously (`{{RESPONSE:}}` + `{{RES_PM_Name:}}`)
- One-way visibility blocking: Session-level configuration to hide specific members' messages from a given agent
- Human disguise: Mark an agent as "Human" to deceive other agents
- Per-agent PM toggle: Group-level master switch + individual enable/disable per agent
- PM messages rendered in purple text + badge indicator
- Anthropic thinking mode poison prevention: Missing thinking blocks in historical messages no longer permanently disable chain-of-thought

**V5.4 Features:**
- Debate/turn order mode: Session-level pro/con side assignment + alternating turn sequence
- @mention probability decay: Prevents two AIs from monopolizing the conversation by repeatedly @mentioning each other in random mode
- AI @mentions in debate mode do not hijack the turn sequence
- Debate role auto-injection into system prompt (informing the AI of its side and speaker number)
- Single message delete button
- TTS settings panel collapsible

**V5.3 Features:**
- Entertainment tools: Dice `{{ROLL: XdY+Z}}` and Tarot cards `{{TAROT: N}}`
- Group-level entertainment feature toggle
- Auto prompt injection (AI automatically learns about available entertainment tools)

**V5.2 Features:**
- Multi-provider TTS voice synthesis (Browser/OpenAI/ElevenLabs/MiniMax/Fish Audio/Azure)
- Custom voice management and agent voice assignment
- Global expand/collapse thinking chain button
- Timeout slider extended to 5 minutes

---

## 1. Core Design Philosophy

This project adopts a **Local-First** and **Serverless** architecture:

*   **State Management**: React `useState` + `useRef` for real-time interaction and streaming responses.
*   **Persistence**: Uses **IndexedDB (Dexie.js)** as the local database; all data (API keys, configurations, chat history) is stored in the user's browser.
*   **Logic Layering**: UI components handle rendering only; complex logic is encapsulated in the `services/` directory.
*   **Polymorphic Adapters**: Uses the adapter pattern to unify input/output differences across Google Gemini, OpenAI, Anthropic, and other APIs.

---

## 2. Directory Structure

```text
src/
├── components/          # UI component layer
│   ├── ChatBubble.tsx   # Core component: renders messages, Markdown, thinking chain, attachments
│   ├── Sidebar.tsx      # Left sidebar: global config, character editing, session switching
│   └── RightSidebar.tsx # Right sidebar: group member management, quick actions
│
├── services/            # Business logic and data layer (Service Layer)
│   ├── db.ts            # IndexedDB database management (CRUD)
│   ├── geminiService.ts # Gemini API adapter (with prompt injection)
│   ├── openaiService.ts # OpenAI-compatible interface adapter (with prompt injection)
│   ├── anthropicService.ts # Claude native API adapter (with prompt injection)
│   ├── searchService.ts # Web search service (Serper/Tavily/Brave)
│   ├── fileParser.ts    # Frontend file parsing (PDF/Docx -> Text) + image compression
│   ├── modelFetcher.ts  # Remote model list fetching
│   ├── visionProxyService.ts # Vision proxy (enables text-only models to "see" images)
│   ├── summaryService.ts# Auto-naming and memory summarization service
│   ├── ttsService.ts    # TTS voice synthesis service (multi-provider adapter)
│   └── entertainmentService.ts # Entertainment tools (dice/tarot)
│
├── types.ts             # TypeScript type definitions (data contracts)
├── constants.ts         # Constants, defaults, logo mappings
├── App.tsx              # Main controller (Controller)
├── main.tsx             # Entry point
└── index.css            # Tailwind style imports
```

---

## 3. Core Data Models (`types.ts`)

Understanding the data models is key to extending the system.

### 3.1 `ChatGroup` (Group) - Added in V5.1
A group is the top-level container, holding multiple conversations with shared members and scenario settings.
```typescript
interface ChatGroup {
  id: string;
  name: string;
  memberIds: string[];     // Shared member list
  scenario?: string;       // Shared scenario (World View)
  memoryConfig: MemoryConfig; // Shared memory configuration
  entertainmentConfig?: EntertainmentConfig; // Entertainment tool config (V5.3)
  createdAt: number;
}

interface EntertainmentConfig {
  enableDice: boolean;     // Enable dice {{ROLL: XdY+Z}}
  enableTarot: boolean;    // Enable tarot {{TAROT: N}}
  enablePM?: boolean;      // Enable private messaging (V5.5)
}
```

### 3.2 `ChatSession` (Session)
Stores the message history of a conversation, belonging to a group.
```typescript
interface ChatSession {
  id: string;
  groupId: string;         // Parent group
  name: string;
  messages: Message[];     // Message list
  lastUpdated: number;
  mutedAgentIds: string[]; // Mute list
  mutedAgents: MuteInfo[]; // Detailed mute info (with expiration time)
  yieldedAgentIds: string[]; // PASS exemption list

  // Independent memory (per session)
  summary?: string;        // Long-term memory text
  adminNotes?: string[];   // Admin temporary notes

  // Debate/turn order mode (V5.4)
  debateConfig?: DebateConfig; // undefined = random mode

  // Fine-grained visibility control (V5.5)
  agentVisibility?: Record<string, string[]>; // key=agentId, value=list of agentIds this agent cannot see
  humanDisguise?: string[];    // List of agentIds marked as "Human"
}
```

### 3.5 `DebateConfig` (Debate Configuration) - Added in V5.4
Session-level turn order configuration, supporting both random and debate modes.
```typescript
type TurnMode = 'random' | 'debate';
type DebateSide = 'pro' | 'con';

interface DebateAssignment {
  agentId: string;
  side: DebateSide;        // Pro or Con
  order: number;           // 1-based, speaker order within the side
}

interface DebateConfig {
  turnMode: TurnMode;
  assignments: DebateAssignment[];
  breathingTime?: number;  // Session-level speaking interval override (ms), uses global value when undefined
  currentTurnIndex: number;// Current turn position (index in the flattened sequence)
}
```
*   **No DB migration needed**: Dexie stores JSON; new field `undefined` = random mode, backward compatible.

### 3.3 `Agent` (AI Agent/Character)
Defines an AI persona.
```typescript
interface Agent {
  id: string;
  name: string;
  providerId: string;      // Associated provider
  modelId: string;         // Specific model (e.g. gpt-4o)
  systemPrompt: string;    // Character prompt
  config: AgentConfig;     // Independent parameters (Temperature, MaxTokens, Reasoning)
  role: AgentRole;         // 'MEMBER' | 'ADMIN'
  isActive?: boolean;      // Whether enabled
  enablePM?: boolean;      // Whether this agent can use private messaging (V5.5)
  searchConfig?: SearchConfig; // Search tool configuration
  voiceId?: string;        // TTS voice ID
  voiceProviderId?: string;// TTS provider ID
}
```

### 3.4 `TTSProvider` (TTS Provider) - Added in V5.2
Similar to `ApiProvider`, used to manage multiple TTS providers.
```typescript
interface TTSProvider {
  id: string;
  name: string;            // Display name
  type: TTSEngineType;     // 'browser' | 'openai' | 'elevenlabs' | 'minimax' | 'fishaudio' | 'azure'
  apiKey?: string;
  baseUrl?: string;        // Custom endpoint
  voices: TTSVoice[];      // Available voice list
  pricePer1MChars?: number;// Price per million characters (USD)
  freeQuota?: string;      // Free quota description
}

interface TTSVoice {
  id: string;              // Voice identifier
  name: string;            // Display name
  lang?: string;           // Language code
  gender?: 'male' | 'female' | 'neutral';
  isCustom?: boolean;      // User-defined custom voice
}

interface TTSSettings {
  enabled: boolean;
  activeProviderId?: string;  // Currently selected provider
  rate: number;               // Speech rate (0.5 - 2.0)
  volume: number;             // Volume (0 - 1)
  autoPlayNewMessages: boolean;
}
```

---

## 4. Key Logic Flows (Logic Flow)

### 4.1 Auto-Play Loop (Auto-Play Loop)
Located in `App.tsx`'s `useEffect`:
1.  **Check**: Check concurrency lock (`processingAgents`), pause state (`isAutoPlay`).
2.  **Filter**: Filter eligible AIs (not muted, not yielded, not the last speaker).
    *   In debate mode, cooldown and lastSpeaker restrictions are skipped (order is guaranteed by the turn sequence).
3.  **@Mention Priority**: Handle @mention priority (in debate mode, AI @mentions do not hijack the order).
4.  **@Mention Decay**: In random mode, probability decreases when the same pair of agents repeatedly @mention each other (100%->70%->40%->10%), preventing a two-agent loop.
5.  **Select**: Select agent based on mode:
    *   **Random mode**: Random selection.
    *   **Debate mode**: Select next agent according to the flattened sequence (pro1->con1->pro2->con2...), tracking progress with `debateTurnIndexRef`.
6.  **Trigger**: Call `triggerAgentReply`, using session-level `breathingTime` override (if configured).

### 4.2 Trigger Reply (`triggerAgentReply`)
This is the system's core dispatch function:
1.  **Lock**: Add the AI's ID to `processingAgents`.
2.  **Signal**: Create an `AbortController` for timeout circuit-breaking or manual stop.
3.  **Service Call**: Route to the corresponding service (`streamGeminiReply`, etc.) based on `provider.type`.
4.  **Stream & Parse**: 
    *   Receive streaming data.
    *   **Command parsing**: Regex scan for `{{PASS}}`, `{{REPLY:id}}`, `{{MUTE:name}}`, `{{NOTE:content}}`.
5.  **Commit**: After generation completes, execute admin commands (e.g. mute), calculate token cost, update state, release lock.

### 4.3 Text Command Protocol (Text Command Protocol)
To allow AI to operate UI features (such as muting, note-taking, searching), we defined a text-based protocol instead of using complex Function Calling. This ensures maximum cross-model compatibility.

**Complete Command List:**
| Command | Permission | Description |
|---------|------------|-------------|
| `{{PASS}}` | All | Skip this turn |
| `{{REPLY: id}}` | All | Quote a specific message |
| `{{SEARCH: query}}` | Requires config | AI-initiated web search |
| `{{ROLL: XdY+Z}}` | Requires enable | Roll dice (e.g. 2d6+3) |
| `{{TAROT: N}}` | Requires enable | Draw N tarot cards (supports upright/reversed) |
| `{{RES_PM_Name: content}}` | Requires enable | Send PM to specified member (V5.5) |
| `{{MUTE: Name, Duration}}` | Admin | Mute a member (10min/1h/1d/permanent) |
| `{{UNMUTE: Name}}` | Admin | Unmute a member |
| `{{NOTE: content}}` | Admin | Add a memory note |
| `{{DELNOTE: keyword}}` | Admin | Delete notes containing keyword |
| `{{CLEARNOTES}}` | Admin | Clear all notes |

**Execution Flow:**
*   **Prompt injection**: In `*Service.ts`, we inform the character of available commands.
*   **Command interception**: In `App.tsx`'s streaming read loop, when a command is matched by regex:
    *   The UI layer **hides** the command (invisible to the user).
    *   The code layer **executes** the corresponding logic.

### 4.4 Web Search Flow (Search Flow) - Added in V5.1
1.  **Trigger methods**:
    *   User inputs `/search keyword`
    *   AI outputs `{{SEARCH: keyword}}` (requires search service configured in character settings)
2.  **Execution**: Calls `searchService.performSearch`, supporting Serper/Tavily/Brave/Metaso.
3.  **Result injection**: Search results are inserted as system messages into the chat, triggering another AI reply.
4.  **Loop prevention**: On the second trigger, `disableSearch=true` prevents the AI from seeing the search tool prompt again.

### 4.5 Memory & Summarization System (Memory System)
1.  **Trigger**: `App.tsx` watches `messages.length`. Fires when `count % threshold === 0`.
2.  **Execution**: Calls `summaryService.updateSessionSummary`.
3.  **Synthesis**: `Prompt = Old Summary + Admin Notes + Recent Messages`.
4.  **Update**: Generates a new summary, saves to DB, clears admin notes.
5.  **Closed loop**: The new summary is injected as System Prompt in the next API call, completing the memory loop.

### 4.6 Group Hierarchy (Group Hierarchy) - Added in V5.1
```
Group                    -> Shared: members, scenario, memory config
├── Session 1            -> Independent: messages, summary, notes, mutes
├── Session 2
└── Session 3
```
*   **UI**: Left sidebar displays a two-level collapsible list.
*   **Member management**: Right sidebar operates on the group's `memberIds`, affecting all sessions under that group.
*   **Data migration**: Dexie v2 automatically creates a same-named group for legacy sessions.

### 4.7 Image Compression (Image Compression) - Added in V5.1
Anthropic API limits images to 5MB, so auto-compression is applied on upload:
1.  **Detection**: `fileParser.ts` calculates Base64 size.
2.  **Compression**: Uses Canvas to reduce quality (0.9->0.3) and dimensions (1.0->0.25), outputting JPEG.
3.  **Configuration**: Users can disable or adjust the threshold in settings (default 4MB).

### 4.8 Entertainment Tools System (Entertainment Tools) - Added in V5.3
Provides dice and tarot card features for TRPG, murder mystery, and other role-playing scenarios.

**Dice Rolling System:**
*   **Syntax**: `{{ROLL: XdY+Z}}` - X dice with Y sides + modifier Z
*   **Example**: `{{ROLL: 2d6+3}}` -> `2d6+3 = 11 (4+5+2)`
*   **Implementation**: `entertainmentService.rollDice()` parses the expression and returns detailed breakdown

**Tarot Card System:**
*   **Syntax**: `{{TAROT: N}}` - Draw N cards
*   **Deck**: 22 Major Arcana cards
*   **Upright/Reversed**: Each card has a 50% chance of being reversed, displayed as "The Fool (Reversed)"
*   **Three-card spread**: When N=3, automatically labels Past / Present / Future

**Configuration & Prompt Injection:**
*   Dice/tarot features can be individually toggled in group settings
*   When enabled, usage instructions are automatically injected into the System Prompt
*   After AI completes output, `App.tsx` parses commands and inserts system messages to display results

### 4.9 TTS Voice Synthesis System (Text-to-Speech) - Added in V5.2
Supports multiple TTS providers for message read-aloud functionality.

**Supported Providers:**
| Provider | Type | Price (per million chars) | Features |
|----------|------|--------------------------|----------|
| Browser | Browser native | Free | No API needed, depends on system voices |
| OpenAI | Cloud | $15 | High quality, supports 6 voices |
| ElevenLabs | Cloud | $30 | Most natural, supports custom voice cloning |
| MiniMax | Cloud | $5 | Cost-effective, Chinese-optimized |
| Fish Audio | Cloud | $10 | Open-source friendly, supports self-training |
| Azure | Cloud | $15 | Enterprise-grade, multi-language support |

**Playback Modes:**
*   **Single play**: Click the play button next to a message.
*   **Continuous play**: Start from a specific message and auto-play all subsequent messages.
*   **Auto play**: Automatically read aloud newly generated messages.

**Voice Assignment Logic:**
1.  Prioritize the agent's configured `voiceId` + `voiceProviderId`.
2.  If not configured, randomly assign from the current provider's voice list.
3.  User messages use the default voice.

**Execution Flow:**
```
User clicks play -> ttsService.speak(text, voiceId, provider)
  -> Route to corresponding implementation based on provider.type
  -> playOpenAITTS / playElevenLabsTTS / playMiniMaxTTS / ...
  -> Returns { chars, cost } for expense tracking
```

**Custom Voice Management:**
*   Users can manually add voices not automatically fetched by the provider (input name + ID).
*   Supports assigning a specific voice to each agent individually.

### 4.10 Debate/Turn Order Mode (Debate Turn Mode) - Added in V5.4
Supports session-level configuration of agent speaking order, suitable for formal debates, character confrontations, and similar scenarios.

**Turn Sequence Construction:**
```
assignments: [pro1, pro2, con1, con2, con3]
  -> buildDebateTurnSequence()
  -> [pro1, con1, pro2, con2, con3]  (alternating insertion)
```

**UI Configuration (RightSidebar):**
*   Mode switch: Random / Debate
*   Switching to debate mode automatically assigns members alternately to pro/con sides
*   Supports drag-to-reorder (up/down arrows) and side switching
*   Session-level speaking interval override can be set
*   Agent cards display side badges (Pro1, Con2, etc.)

**Prompt Injection:**
In debate mode, `triggerAgentReply` automatically appends side information to the end of `scenario`:
```
[Debate Mode]
This is debate mode. You have been assigned as [Pro Side Speaker #1].
Pro side members: 1. Gemini, 2. GPT-4o
Con side members: 1. DeepSeek, 2. Claude
Argue from the pro side's position and debate against the opposing side.
```
*   Injected into `scenario` rather than a separate parameter, so the three service files require no modification.

**Anti-Loop Mechanism (@Mention Decay):**
*   In random mode, `mentionPairRef` tracks the number of consecutive mutual @mentions between the same pair of agents.
*   Decay curve: `prob = max(0.1, 1 - count * 0.3)` -> from the 4th time onward, only 10%.
*   When probability check fails, falls through to random agent selection.
*   In debate mode, AI @mention priority is skipped entirely; order is fully controlled by the turn sequence.

**Key Implementation Details:**
*   `currentTurnIndex` uses `useRef` instead of session state to avoid triggering infinite loops in the autoplay `useEffect`.
*   When switching sessions, syncs from `debateConfig.currentTurnIndex` in the session to the ref.
*   Clearing messages resets both the ref and the session's index.
*   Removing an agent automatically cleans up the corresponding assignment.

### 4.11 Private Messaging & Fine-Grained Visibility System (PM & Visibility) - Added in V5.5
Supports private communication between AI and humans, as well as session-level visibility control.

**Private Message (PM) System:**
*   **AI sends PM**: Uses `{{RES_PM_Name: content}}`, can be used simultaneously with `{{RESPONSE:}}` (dual output).
*   **Human sends PM**: PM button next to the input box to select target; after sending, visible only to the target and sender.
*   **Visibility rules**: PM messages are visible only to sender + target + human user, with highest priority (overrides OPEN/BLIND modes).
*   **Dual output**: AI can send both a public message and a PM simultaneously, saved as two separate messages.
*   **UI rendering**: PM message text is rendered in purple, with a purple badge next to the name showing `PM -> target name`.

**Visibility Filtering Priority (unified across all three services):**
```
1. System messages -> Always visible
2. PM messages -> Visible only to sender and target
3. User messages -> Always visible
4. Own messages -> Always visible
5. One-way blocking -> agentVisibility configuration
6. Global mode -> OPEN (all visible) / BLIND (only own messages visible)
```

**One-Way Visibility Blocking:**
*   Session-level config `agentVisibility: Record<string, string[]>`
*   In the RightSidebar, each agent has a collapsible section to configure "whose messages are hidden"
*   PM priority is higher than blocking (PMs from blocked agents are still delivered)

**Human Disguise:**
*   Session-level `humanDisguise: string[]`; marked agents appear as "(Human)" in other AIs' member lists
*   Does not affect self-perception (the agent itself still knows it is an AI)

**Auto-Play & PM Interaction:**
*   PM sent to a human -> Does not trigger any agent
*   PM sent to an AI -> Only triggers the target agent to reply
*   Dual output -> Auto-play is triggered based on the public message; the PM portion is silent

**Anthropic Thinking Mode Compatibility:**
*   PM messages and historical assistant messages missing thinking blocks are downgraded to user-role recall annotations
*   Prevents "poisoning": once thinking is accidentally disabled, it won't be permanently unrecoverable due to old messages
*   `shouldEnableThinking` only checks agent configuration, no longer inspecting historical completeness

---

## 5. Extension Guide: Building Memory & Backend (Future Roadmap)

If you plan to introduce a **Vector DB** or **Backend Database**, refer to the following refactoring path:

### Phase 1: Extract State Logic (Refactor)
Currently `App.tsx` takes on too many Controller responsibilities.
*   **Goal**: Extract chat logic into a Custom Hook, e.g. `useChatEngine`.
*   **Benefit**: `App.tsx` handles layout only; the logic layer becomes clearer, making it easier to connect different data sources.

### Phase 2: Introduce Vector Database (RAG Integration)
The current context is based on a **Sliding Window**. To let the AI recall details from 1000+ messages ago:
1.  **Modification point**: `services/*Service.ts`.
2.  **Actions**:
    *   Before building `formattedMessages`, extract the user's query.
    *   Send the query to a vector database (e.g. Pinecone, or browser-local Transformers.js + Voy).
    *   Retrieve relevant historical records (Relevant Memories).
    *   Insert the retrieved records into the `[Relevant History]` section of the System Prompt.

### Phase 3: Migrate from IndexedDB to PostgreSQL/Supabase
To transform this single-user application into a multi-user online application:
1.  **Replace `services/db.ts`**:
    *   Keep method names unchanged (`loadAllData`, `saveCollection`).
    *   Replace the internal implementation from `dexie` to `fetch('/api/...')` or `supabase-js` client.

---

## 6. Debugging & Building

*   **Local development**: `npm run dev`
*   **Production build**: `npm run build`
