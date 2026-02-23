# Synapse — Architecture Flowcharts

## Table of Contents

1. [System Overview](#1-system-overview)
2. [Bot Startup Sequence](#2-bot-startup-sequence)
3. [Telegram Message Processing](#3-telegram-message-processing)
4. [Agent Lifecycle](#4-agent-lifecycle)
5. [Agent Pool Management](#5-agent-pool-management)
6. [Voice Transcription Pipeline](#6-voice-transcription-pipeline)
7. [Session & Persistence Layer](#7-session--persistence-layer)
8. [Error Handling & Retry Strategy](#8-error-handling--retry-strategy)
9. [Scheduler & Job Execution](#9-scheduler--job-execution)
10. [Health Monitoring](#10-health-monitoring)
11. [Sandbox Isolation](#11-sandbox-isolation)
12. [Runtime Configuration](#12-runtime-configuration)

---

## 1. System Overview

High-level component architecture showing all subsystems and their interactions.

```mermaid
graph TB
    subgraph Entry["Entry Points"]
        REPL["index.ts<br/>REPL Interface"]
        TG["run.ts<br/>Telegram Bot"]
    end

    subgraph Core["Agent Core"]
        AP["AgentPool<br/>Master + Workers"]
        AG["Agent<br/>CLI Wrapper"]
        SB["Sandbox<br/>/tmp/synapse-agent-*"]
        CLI["claude CLI<br/>Bun.spawn()"]
    end

    subgraph Concurrency["Concurrency Control"]
        CQ["ChatQueue<br/>Per-chat Queue"]
        SEM["Semaphore<br/>N permits"]
    end

    subgraph Persistence["Persistence Layer"]
        HM["HistoryManager<br/>Messages"]
        SS["SessionStore<br/>chatId → sessionId"]
        DB[("SQLite<br/>WAL Mode<br/>synapse.db")]
    end

    subgraph Services["Platform Services"]
        RC["RuntimeConfig<br/>Admin Settings"]
        SCH["Scheduler<br/>Croner Jobs"]
        HLT["HealthMonitor<br/>30s Checks"]
        FMT["Formatter<br/>MD → HTML"]
        MEM["Memory<br/>Context Builder"]
        MCP["MCP Config<br/>7 Servers"]
        WSP["Whisper<br/>Groq + Local"]
        ID["AgentIdentity<br/>Matrix Names"]
    end

    REPL --> AG
    TG --> CQ
    CQ --> SEM
    SEM --> AP
    AP --> AG
    AG --> SB
    AG --> CLI
    AG --> HM
    AG --> SS
    HM --> DB
    SS --> DB
    RC --> DB
    SCH --> DB
    SCH --> AP
    HLT --> DB
    HLT -.->|alerts| TG
    AP --> MEM
    AP --> ID
    AG --> MCP
    WSP -.->|transcription| AG
    FMT -.->|response| TG

    style DB fill:#f9f,stroke:#333,stroke-width:2px
    style CLI fill:#ff9,stroke:#333,stroke-width:2px
    style AP fill:#9ff,stroke:#333,stroke-width:2px
```

---

## 2. Bot Startup Sequence

Complete initialization flow when `run.ts` is executed.

```mermaid
flowchart TD
    START([bun run run.ts]) --> VALIDATE_ENV{Required env vars?}
    VALIDATE_ENV -->|Missing| FATAL[/"FATAL: Exit(1)"/]
    VALIDATE_ENV -->|OK| LOAD_CONFIG[Load AgentConfig<br/>Range validation + clamping]

    LOAD_CONFIG --> INIT_DB[Initialize Database<br/>SQLite WAL mode<br/>Run migrations]
    INIT_DB --> INIT_STORE[Initialize SessionStore<br/>Load cache from DB]
    INIT_STORE --> CLEAR_SESSIONS[Clear stale sessions<br/>CLI sessions don't survive restart]

    CLEAR_SESSIONS --> INIT_RC[Initialize RuntimeConfig<br/>Load persisted overrides]
    INIT_RC --> BUILD_MCP[Build MCP Config<br/>Memory + Thinking + FS + Git + SQLite]

    BUILD_MCP --> CHECK_WHISPER{Whisper configured?}
    CHECK_WHISPER -->|Yes| VALIDATE_WHISPER[Validate whisper-cli + ffmpeg]
    CHECK_WHISPER -->|No| CHECK_GROQ

    VALIDATE_WHISPER --> CHECK_GROQ{Groq API key?}
    CHECK_GROQ -->|Yes| WHISPER_READY[WhisperConfig ready<br/>Groq primary + local fallback]
    CHECK_GROQ -->|No| WHISPER_LOCAL[WhisperConfig ready<br/>Local only]

    WHISPER_READY --> INIT_HEALTH
    WHISPER_LOCAL --> INIT_HEALTH
    CHECK_WHISPER -->|No Groq| NO_VOICE[Voice disabled]
    NO_VOICE --> INIT_HEALTH

    INIT_HEALTH[Start HealthMonitor<br/>DB + Groq + Whisper + Memory<br/>every 30s] --> REGISTER_COMMANDS

    REGISTER_COMMANDS[Register Bot Commands<br/>/start /help /reset /stats<br/>/ping /export /config /schedule /jobs] --> REGISTER_HANDLERS

    REGISTER_HANDLERS[Register Message Handlers<br/>text, photo, document<br/>voice, audio, edited] --> START_POLLING

    START_POLLING[bot.start polling] --> ON_START

    ON_START --> CLEANUP_OLD[Cleanup old sessions<br/>> 90 days]
    CLEANUP_OLD --> CLEANUP_ORPHAN[Cleanup orphan<br/>telegram_sessions]
    CLEANUP_ORPHAN --> LOAD_SCHEDULER[Load active jobs<br/>Create Cron instances]
    LOAD_SCHEDULER --> SEND_WAKEUP[Send wake-up to all chats<br/>Uptime + Memory + MCP + Team]
    SEND_WAKEUP --> READY([Bot Ready])

    style FATAL fill:#f66,stroke:#333
    style READY fill:#6f6,stroke:#333
    style INIT_DB fill:#f9f,stroke:#333
```

---

## 3. Telegram Message Processing

Complete flow from user message to response delivery, covering all message types.

```mermaid
flowchart TD
    MSG([User sends message]) --> TYPE{Message type?}

    TYPE -->|text| TEXT_CHECK{Starts with /?}
    TEXT_CHECK -->|Yes| COMMAND[Route to command handler]
    TEXT_CHECK -->|No| TEXT_TYPING[Send typing action]
    TEXT_TYPING --> TEXT_QUEUE[ChatQueue.enqueue chatId]

    TYPE -->|photo| PHOTO_TYPING[Send typing action]
    PHOTO_TYPING --> PHOTO_QUEUE[ChatQueue.enqueue chatId]
    PHOTO_QUEUE --> PHOTO_DL[Download largest photo<br/>Telegram CDN → base64]
    PHOTO_DL --> PHOTO_SIZE{Size ≤ 20 MB?}
    PHOTO_SIZE -->|No| SIZE_ERR[Reply: file troppo grande]
    PHOTO_SIZE -->|Yes| PHOTO_EXEC[executeWithRetry<br/>callWithRawImage]

    TYPE -->|document| DOC_TYPING[Send typing action]
    DOC_TYPING --> DOC_QUEUE[ChatQueue.enqueue chatId]
    DOC_QUEUE --> DOC_DL[Download to sandbox<br/>agent.sandboxDir/filename]
    DOC_DL --> DOC_EXEC[executeWithRetry<br/>agent.call with file ref]

    TYPE -->|voice / audio| VOICE_CHECK{Whisper configured?}
    VOICE_CHECK -->|No| VOICE_ERR[Reply: trascrizione non disponibile]
    VOICE_CHECK -->|Yes| VOICE_TYPING[Send typing action]
    VOICE_TYPING --> VOICE_QUEUE[ChatQueue.enqueue chatId]
    VOICE_QUEUE --> VOICE_DL[Download OGG to sandbox]
    VOICE_DL --> TRANSCRIBE[transcribe<br/>Groq primary → local fallback]
    TRANSCRIBE --> VOICE_PREVIEW[Reply: 🎙 quoted text]
    VOICE_PREVIEW --> VOICE_EXEC["executeWithRetry<br/>agent.call('[vocale] text')"]

    TYPE -->|edited_message| EDIT_PREFIX["Prefix: [Messaggio modificato]"]
    EDIT_PREFIX --> EDIT_QUEUE[ChatQueue.enqueue chatId]
    EDIT_QUEUE --> EDIT_EXEC[executeWithRetry]

    TEXT_QUEUE --> SEMAPHORE

    subgraph EXEC["executeWithRetry"]
        SEMAPHORE[Semaphore.acquire<br/>Wait for permit] --> ACQUIRE[AgentPool.acquire<br/>Master or Worker]
        ACQUIRE --> IDENTITY[Format identity header<br/>🤖 Synapse SYN-01]
        IDENTITY --> STATUS_MSG[Reply: agent sta elaborando...]
        STATUS_MSG --> SNAPSHOT[Snapshot sandbox files<br/>Map path → mtime]
        SNAPSHOT --> CALL[Agent.call / callWithImage]
        CALL --> HISTORY[HistoryManager.addMessage<br/>Always under primary session]
        HISTORY --> ATTACH{Has attachment?}
        ATTACH -->|Yes| SAVE_ATTACH[Save BLOB to attachments table]
        ATTACH -->|No| FORMAT
        SAVE_ATTACH --> FORMAT
        FORMAT[formatForTelegram<br/>MD → HTML + chunk ≤ 4096]
        FORMAT --> SEND_CHUNKS[Send chunks<br/>First replies to original msg]
        SEND_CHUNKS --> SANDBOX_FILES[Send new output/ files]
        SANDBOX_FILES --> PERSIST{Is master?}
        PERSIST -->|Yes| SAVE_SESSION[Persist session ID to DB]
        PERSIST -->|No| RELEASE
        SAVE_SESSION --> RELEASE[AgentPool.release agent]
        RELEASE --> SEM_RELEASE[Semaphore.release]
    end

    PHOTO_EXEC --> SEMAPHORE
    DOC_EXEC --> SEMAPHORE
    VOICE_EXEC --> SEMAPHORE
    EDIT_EXEC --> SEMAPHORE

    style MSG fill:#9cf,stroke:#333
    style EXEC fill:#ffe,stroke:#333,stroke-width:2px
```

---

## 4. Agent Lifecycle

How a single Agent spawns the Claude CLI, handles I/O, parses responses, and manages timeouts.

```mermaid
flowchart TD
    CREATE([new Agent config]) --> SANDBOX[createSandbox<br/>/tmp/synapse-agent-UUID]
    SANDBOX --> WRITE_RULES[Write CLAUDE.md<br/>Safety rules to sandbox]

    subgraph CALL["agent.call(prompt)"]
        RETRY_WRAPPER[callWithRetry wrapper<br/>Max N retries] --> BUILD_ARGS

        BUILD_ARGS["buildArgs(prompt)<br/>claude --print --model opus<br/>--output-format json"] --> ADD_FLAGS

        ADD_FLAGS{Optional flags?}
        ADD_FLAGS -->|resume| ADD_RESUME["--resume sessionId"]
        ADD_FLAGS -->|system prompt| ADD_SYSTEM["--system-prompt '...'"]
        ADD_FLAGS -->|MCP| ADD_MCP["--mcp-config path"]
        ADD_FLAGS -->|skip perms| ADD_SKIP["--dangerously-skip-permissions"]

        ADD_RESUME --> SPAWN
        ADD_SYSTEM --> SPAWN
        ADD_MCP --> SPAWN
        ADD_SKIP --> SPAWN

        SPAWN["Bun.spawn(args)<br/>cwd: sandboxDir<br/>env: buildSpawnEnv(token)"] --> PARALLEL

        PARALLEL["Promise.all<br/>Read stdout + stderr<br/>in parallel"] --> RACE

        RACE{"Race with timeout<br/>max(config, 5min)"}
        RACE -->|Timeout| KILL["proc.kill('SIGTERM')<br/>throw TimeoutError"]
        RACE -->|Complete| EXIT_CODE{Exit code?}

        EXIT_CODE -->|0| PARSE["parseResponse(stdout)<br/>Extract JSON result"]
        EXIT_CODE -->|≠0| CHECK_TRANSIENT{Transient error?}

        PARSE --> EXTRACT["Extract:<br/>• text (result)<br/>• sessionId<br/>• inputTokens<br/>• outputTokens"]
        EXTRACT --> RETURN([Return AgentCallResult])

        CHECK_TRANSIENT -->|"429, 503, ETIMEDOUT<br/>ECONNRESET"| BACKOFF["Exponential backoff<br/>delay × 2^attempt<br/>cap 30s"]
        CHECK_TRANSIENT -->|Permanent| THROW[Throw error]

        BACKOFF --> RETRY_WRAPPER

        KILL --> THROW_TIMEOUT[Throw TimeoutError<br/>Never retried]
    end

    subgraph CLEANUP["Lifecycle End"]
        ABORT["agent.abort()<br/>Kill active process"]
        CLEAN["agent.cleanup()<br/>rm -rf sandboxDir"]
    end

    WRITE_RULES --> CALL
    RETURN --> DONE([Agent ready for next call])

    style CALL fill:#ffe,stroke:#333,stroke-width:2px
    style SPAWN fill:#ff9,stroke:#333,stroke-width:2px
    style KILL fill:#f66,stroke:#333
```

---

## 5. Agent Pool Management

Master/worker concurrency model with acquire/release semantics.

```mermaid
flowchart TD
    subgraph INIT["Pool Initialization"]
        CREATE_POOL([new AgentPool<br/>chatId, primaryAgent, config]) --> MASTER[Master slot<br/>Synapse 🤖 SYN-01<br/>Uses --resume]
        CREATE_POOL --> WORKERS["Create N-1 workers<br/>Morpheus, Trinity, Tank...<br/>Each with unique identity"]
    end

    subgraph ACQUIRE["pool.acquire()"]
        REQ([Request agent]) --> CHECK_MASTER{Master free?}
        CHECK_MASTER -->|Yes| RETURN_MASTER[Return master<br/>isOverflow: false]
        CHECK_MASTER -->|No| CHECK_WORKER{Any worker free?}
        CHECK_WORKER -->|Yes| REFRESH_MEM["refreshWorkerMemory<br/>Fetch 100 recent messages<br/>Build full context<br/>Inject via system prompt"]
        REFRESH_MEM --> RETURN_WORKER[Return worker<br/>isOverflow: true]
        CHECK_WORKER -->|No| CREATE_OVERFLOW["Create temporary agent<br/>⚠️ Log overflow warning"]
        CREATE_OVERFLOW --> RETURN_OVERFLOW[Return overflow<br/>isOverflow: true]
    end

    subgraph RELEASE["pool.release(agent, isOverflow)"]
        REL([Release agent]) --> IS_OVERFLOW{isOverflow?}
        IS_OVERFLOW -->|"No (master)"| MARK_FREE_M[Mark master available]
        IS_OVERFLOW -->|"Yes (worker)"| IS_TEMP{Is temporary?}
        IS_TEMP -->|Yes| CLEANUP_TEMP["agent.cleanup()<br/>Remove temp sandbox"]
        IS_TEMP -->|"No (worker)"| CLEAR_SESSION["Clear sessionId<br/>Mark available"]
    end

    subgraph LRU["LRU Eviction (cap: 500 pools)"]
        EVICT([Pool evicted]) --> ABORT_ALL["Abort all agents<br/>master + workers"]
        ABORT_ALL --> CLEANUP_ALL["Cleanup all sandboxes<br/>rm -rf /tmp/synapse-agent-*"]
    end

    RETURN_MASTER --> USE([Execute call])
    RETURN_WORKER --> USE
    RETURN_OVERFLOW --> USE
    USE --> REL

    style ACQUIRE fill:#e6f3ff,stroke:#333,stroke-width:2px
    style RELEASE fill:#fff3e6,stroke:#333,stroke-width:2px
    style LRU fill:#ffe6e6,stroke:#333,stroke-width:2px
```

---

## 6. Voice Transcription Pipeline

Dual-path STT: Groq cloud (primary) with local whisper-cli fallback.

```mermaid
flowchart TD
    VOICE([Voice/Audio message]) --> DOWNLOAD[Download from Telegram CDN<br/>Save OGG to sandbox]

    DOWNLOAD --> GROQ_CHECK{Groq API key?}

    GROQ_CHECK -->|Yes| GROQ_REQ["POST api.groq.com<br/>whisper-large-v3-turbo<br/>OGG direct (no conversion)<br/>Timeout: 30s"]

    GROQ_REQ --> GROQ_OK{Success?}
    GROQ_OK -->|Yes| GROQ_TEXT[Extract text from JSON]
    GROQ_OK -->|"No (error/timeout)"| LOCAL_CHECK

    GROQ_CHECK -->|No| LOCAL_CHECK{Local whisper?}

    LOCAL_CHECK -->|No| NO_STT[/"Error: no STT available"/]

    LOCAL_CHECK -->|Yes| CONVERT["ffmpeg conversion<br/>OGG Opus → WAV<br/>16kHz mono PCM"]

    CONVERT --> WHISPER["whisper-cli<br/>--model large-v3-turbo<br/>--beam-size 8<br/>--best-of 8<br/>--flash-attn<br/>--prompt 'Trascrivi accuratamente.'<br/>Timeout: 2 min"]

    WHISPER --> PARSE["parseWhisperOutput<br/>Strip [HH:MM:SS.mmm] timestamps<br/>Join lines"]

    GROQ_TEXT --> PREVIEW["Reply to user<br/>🎙 'transcribed text'"]
    PARSE --> PREVIEW

    PREVIEW --> AGENT["Agent.call<br/>'[vocale] transcribed text'"]

    AGENT --> RESPONSE([Send Claude response])

    style GROQ_REQ fill:#9f9,stroke:#333
    style WHISPER fill:#ff9,stroke:#333
    style NO_STT fill:#f66,stroke:#333
```

---

## 7. Session & Persistence Layer

How sessions, messages, and attachments flow through the persistence layer.

```mermaid
flowchart TD
    subgraph Telegram["Telegram Bot"]
        TG_MSG([User message])
        TG_RESP([Bot response])
    end

    subgraph SessionMgmt["Session Management"]
        SS["SessionStore<br/>(in-memory cache)"]
        SS_DB["telegram_sessions table<br/>chatId → sessionId"]

        GET_SESSION{Session exists<br/>for chatId?}
        GET_SESSION -->|Yes| RESUME["Agent --resume sessionId"]
        GET_SESSION -->|No| NEW_SESSION["Agent creates new session<br/>Claude CLI returns sessionId"]
        NEW_SESSION --> SAVE_SESSION["SessionStore.set<br/>Cache + DB write"]
    end

    subgraph History["Message Persistence"]
        HM["HistoryManager"]
        INSERT_MSG["db.insertMessage<br/>prompt, response<br/>duration_ms, tokens"]
        INSERT_ATTACH["db.insertAttachment<br/>mediaType, BLOB, fileId"]
    end

    subgraph Database["SQLite Database (WAL)"]
        SESSIONS[("sessions<br/>session_id, chat_id<br/>created_at, updated_at")]
        MESSAGES[("messages<br/>prompt, response<br/>duration_ms, tokens")]
        ATTACHMENTS[("attachments<br/>media_type, data BLOB<br/>file_id")]
        TG_SESSIONS[("telegram_sessions<br/>chat_id → session_id")]
        CONFIG[("runtime_config<br/>key → value")]
        JOBS[("scheduled_jobs<br/>prompt, cron_expr")]
    end

    subgraph Queries["Read Operations"]
        RECENT["getRecentMessages<br/>Last N for display"]
        RECENT_CHAT["getRecentMessagesByChatId<br/>Last 100 for memory injection"]
        STATS["getSessionStats<br/>SQL aggregates"]
        EXPORT["getMessages<br/>Full session for /export"]
    end

    TG_MSG --> GET_SESSION
    RESUME --> CALL[Agent.call]
    CALL --> INSERT_MSG
    INSERT_MSG --> MESSAGES
    INSERT_MSG -->|messageId| INSERT_ATTACH
    INSERT_ATTACH --> ATTACHMENTS
    SAVE_SESSION --> SS
    SS --> SS_DB
    SS_DB --> TG_SESSIONS
    CALL --> UPSERT["db.upsertSession<br/>Update timestamps"]
    UPSERT --> SESSIONS

    MESSAGES --> RECENT
    MESSAGES --> RECENT_CHAT
    MESSAGES --> STATS
    MESSAGES --> EXPORT

    RECENT_CHAT --> MEMORY["buildFullConversationContext<br/>→ Worker system prompt"]

    CALL --> TG_RESP

    style Database fill:#f9f,stroke:#333,stroke-width:2px
    style SESSIONS fill:#fcf,stroke:#333
    style MESSAGES fill:#fcf,stroke:#333
```

---

## 8. Error Handling & Retry Strategy

Multi-layer error handling: transient retries, session error recovery, and timeout management.

```mermaid
flowchart TD
    CALL([Agent.call]) --> SPAWN[Bun.spawn claude CLI]

    SPAWN --> RACE{"Race:<br/>process vs timeout"}

    RACE -->|Timeout exceeded| KILL["Kill process SIGTERM<br/>TimeoutError"]
    KILL --> NEVER_RETRY[/"❌ Never retried<br/>Reply: Timeout"/]

    RACE -->|Process exits| EXIT{Exit code}

    EXIT -->|0| PARSE[Parse JSON response]
    PARSE --> CHECK_JSON{Valid JSON?}
    CHECK_JSON -->|Yes| SUCCESS([Return AgentCallResult])
    CHECK_JSON -->|No| FALLBACK[Use raw stdout as text]
    FALLBACK --> SUCCESS

    EXIT -->|≠ 0| CLASSIFY{Error type?}

    CLASSIFY -->|"Transient<br/>429 Rate Limit<br/>503 Overloaded<br/>ETIMEDOUT<br/>ECONNRESET<br/>EPIPE"| RETRY_CHECK{Attempts < maxRetries?}

    RETRY_CHECK -->|Yes| BACKOFF["Wait: delay × 2^attempt<br/>Cap: 30 seconds<br/>1s → 2s → 4s → 8s → ..."]
    BACKOFF --> SPAWN

    RETRY_CHECK -->|No| PERMANENT_FAIL[Throw: max retries exceeded]

    CLASSIFY -->|Permanent error| PERMANENT_FAIL

    subgraph SESSION_RECOVERY["Session Error Recovery (Telegram only)"]
        PERMANENT_FAIL --> IS_SESSION{Session error?<br/>• invalid session<br/>• session not found<br/>• could not resume}

        IS_SESSION -->|"Yes + master"| RESET["Reset agent session<br/>Create fresh Agent<br/>Clear history cache"]
        RESET --> RETRY_FRESH[Retry with new agent<br/>No --resume flag]
        RETRY_FRESH --> FRESH_OK{Success?}
        FRESH_OK -->|Yes| FRESH_SUCCESS([Return result])
        FRESH_OK -->|No| FINAL_ERROR

        IS_SESSION -->|No / worker| FINAL_ERROR["❌ Reply error to user"]
    end

    style NEVER_RETRY fill:#f66,stroke:#333
    style FINAL_ERROR fill:#f66,stroke:#333
    style SUCCESS fill:#6f6,stroke:#333
    style FRESH_SUCCESS fill:#6f6,stroke:#333
    style SESSION_RECOVERY fill:#fff3e6,stroke:#333,stroke-width:2px
```

---

## 9. Scheduler & Job Execution

Job lifecycle from creation through cron scheduling to execution.

```mermaid
flowchart TD
    subgraph Creation["Job Creation"]
        USER["/schedule expr prompt"] --> PARSE_SCHED["parseSchedule(expr)"]

        PARSE_SCHED --> SCHED_TYPE{Schedule type?}

        SCHED_TYPE -->|"at HH:MM<br/>alle HH:MM"| ONCE["type: once<br/>runAt: next HH:MM"]
        SCHED_TYPE -->|"every HH:MM<br/>ogni HH:MM"| DAILY["type: recurring<br/>cron: 0 M H * * *"]
        SCHED_TYPE -->|"every Ns/Nm/Nh"| INTERVAL["type: recurring<br/>interval: N ms<br/>min 30s"]
        SCHED_TYPE -->|"in Ns/Nm/Nh"| DELAY["type: delay<br/>runAt: now + N"]
        SCHED_TYPE -->|"cron expr"| CRON["type: cron<br/>cronExpr: expr"]

        ONCE --> TO_CRON["toCronExpr(spec)<br/>→ cron expression"]
        DAILY --> TO_CRON
        INTERVAL --> TO_CRON
        DELAY --> TO_CRON
        CRON --> TO_CRON

        TO_CRON --> CHECK_LIMIT{Jobs < 20<br/>for this chat?}
        CHECK_LIMIT -->|No| LIMIT_ERR[/"Error: max 20 jobs"/]
        CHECK_LIMIT -->|Yes| INSERT_DB["db.insertJob<br/>Persist to scheduled_jobs"]
        INSERT_DB --> CREATE_CRON["new Cron(expr)<br/>Start timer"]
    end

    subgraph Execution["Job Execution Cycle"]
        CRON_FIRE([Cron fires]) --> EXECUTE["JobExecutor callback"]
        EXECUTE --> ACQUIRE_AGENT[Get agent for chatId]
        ACQUIRE_AGENT --> AGENT_CALL[Agent.call prompt]
        AGENT_CALL --> FORMAT[Format response]
        FORMAT --> SEND[Send to Telegram chat]
        SEND --> UPDATE_RUN["db.updateJobLastRun"]

        AGENT_CALL -->|Error| FAIL_COUNT{Consecutive<br/>failures ≥ 3?}
        FAIL_COUNT -->|Yes| DEACTIVATE["Deactivate job<br/>db.markJobDone"]
        FAIL_COUNT -->|No| INCREMENT[Increment failure count]
    end

    subgraph Lifecycle["Job Lifecycle"]
        IS_ONCE{once / delay?}
        IS_ONCE -->|Yes| MARK_DONE["db.markJobDone<br/>active = 0"]
        IS_ONCE -->|No| CONTINUE[Continue recurring]

        DELETE_CMD["/jobs → delete"] --> STOP_CRON["Stop Cron instance"]
        STOP_CRON --> DELETE_DB["db.deleteJob"]
    end

    UPDATE_RUN --> IS_ONCE
    CREATE_CRON --> CRON_FIRE

    style Creation fill:#e6f3ff,stroke:#333,stroke-width:2px
    style Execution fill:#fff3e6,stroke:#333,stroke-width:2px
    style DEACTIVATE fill:#f66,stroke:#333
```

---

## 10. Health Monitoring

System health check cycle with state-change alerting.

```mermaid
flowchart TD
    START([HealthMonitor.start<br/>every 30s]) --> CHECK_CYCLE

    subgraph CHECK_CYCLE["Health Check Cycle"]
        DB_CHECK["DB Check<br/>SELECT 1 query"] --> DB_STATUS{OK?}
        DB_STATUS -->|Yes| DB_OK["db: true ✅"]
        DB_STATUS -->|No| DB_FAIL["db: false 🚨"]

        GROQ_CHECK{"Groq configured?"} -->|Yes| GROQ_REQ["HEAD api.groq.com<br/>Timeout: 5s"]
        GROQ_REQ --> GROQ_STATUS{OK?}
        GROQ_STATUS -->|Yes| GROQ_OK["groq: true ✅"]
        GROQ_STATUS -->|No| GROQ_FAIL["groq: false 🚨"]
        GROQ_CHECK -->|No| GROQ_NULL["groq: null"]

        WHISPER_CHECK{"Whisper configured?"} -->|Yes| WHISPER_WHICH["which whisper-cli"]
        WHISPER_WHICH --> WHISPER_STATUS{Found?}
        WHISPER_STATUS -->|Yes| WHISPER_OK["whisper: true ✅"]
        WHISPER_STATUS -->|No| WHISPER_FAIL["whisper: false 🚨"]
        WHISPER_CHECK -->|No| WHISPER_NULL["whisper: null"]

        MEM_CHECK["process.memoryUsage<br/>RSS in MB"] --> MEM_THRESHOLD{RSS > 512 MB?}
        MEM_THRESHOLD -->|Yes| MEM_HIGH["memory: high 🚨"]
        MEM_THRESHOLD -->|No| MEM_OK["memory: normal ✅"]
    end

    subgraph COMPARE["State Change Detection"]
        COLLECT["Collect current status"] --> FIRST{First run?}
        FIRST -->|Yes| SAVE_STATE["Save as baseline<br/>No alert"]
        FIRST -->|No| DIFF["Compare with previous state"]

        DIFF --> CHANGED{Any changes?}
        CHANGED -->|No| LOG_DEBUG["Log debug: all stable"]
        CHANGED -->|Yes| BUILD_ALERT

        BUILD_ALERT["Build alert message"] --> ALERT_TYPE{Change type?}
        ALERT_TYPE -->|Recovery| RECOVERY["✅ Component ripristinato"]
        ALERT_TYPE -->|Failure| FAILURE["🚨 Component non raggiungibile"]
        ALERT_TYPE -->|Memory| MEM_ALERT["⚠️ Memoria elevata: X MB"]

        RECOVERY --> SEND_ALERT["Send Telegram alert<br/>to TELEGRAM_ADMIN_ID"]
        FAILURE --> SEND_ALERT
        MEM_ALERT --> SEND_ALERT
    end

    DB_OK --> COLLECT
    DB_FAIL --> COLLECT
    GROQ_OK --> COLLECT
    GROQ_FAIL --> COLLECT
    GROQ_NULL --> COLLECT
    WHISPER_OK --> COLLECT
    WHISPER_FAIL --> COLLECT
    WHISPER_NULL --> COLLECT
    MEM_OK --> COLLECT
    MEM_HIGH --> COLLECT

    SEND_ALERT --> SAVE_NEW["Save current as previous"]
    SAVE_STATE --> WAIT
    LOG_DEBUG --> WAIT
    SAVE_NEW --> WAIT
    WAIT(["Wait 30s"]) --> CHECK_CYCLE

    style CHECK_CYCLE fill:#e6f3ff,stroke:#333,stroke-width:2px
    style COMPARE fill:#fff3e6,stroke:#333,stroke-width:2px
    style FAILURE fill:#f66,stroke:#333
    style RECOVERY fill:#6f6,stroke:#333
```

---

## 11. Sandbox Isolation

How each agent is isolated in a temporary directory with safety rules.

```mermaid
flowchart TD
    subgraph CREATE["Sandbox Creation"]
        NEW_AGENT([new Agent]) --> MKTEMP["mkdtempSync<br/>/tmp/synapse-agent-XXXXXX"]
        MKTEMP --> WRITE_RULES["Write CLAUDE.md<br/>Safety rules"]
    end

    subgraph RULES["Safety Rules (CLAUDE.md)"]
        direction LR
        FORBIDDEN["🚫 Forbidden Paths<br/>/etc, /usr, /bin, /lib<br/>~/.ssh, ~/.aws, ~/.env<br/>~/.gnupg, ~/.config"]
        DESTRUCTIVE["🚫 Destructive Commands<br/>rm -rf /, mkfs, fdisk<br/>shutdown, reboot<br/>sudo, su, chmod 777"]
        SERVICES["🚫 Service Management<br/>systemctl, launchctl<br/>crontab, kill -9"]
        NETWORK["🚫 Network/Firewall<br/>iptables, ufw<br/>route delete"]
        ALLOWED["✅ Allowed Operations<br/>Read-only commands<br/>Sandbox file ops<br/>Network GET requests<br/>Code execution in sandbox"]
    end

    subgraph RUNTIME["Agent Runtime"]
        SPAWN["Bun.spawn claude<br/>cwd: sandboxDir"] --> ENV["buildSpawnEnv(token)<br/>Cached per token<br/>Strips sensitive vars"]
        ENV --> EXECUTE["Claude CLI executes<br/>within sandbox directory"]
        EXECUTE --> FILES["Files created in sandbox"]
        FILES --> OUTPUT{In output/ dir?}
        OUTPUT -->|Yes| DELIVER["Auto-delivered to user<br/>via Telegram"]
        OUTPUT -->|No| STAY["Stays in sandbox<br/>Available to agent"]
    end

    subgraph CLEANUP_FLOW["Cleanup"]
        LRU_EVICT["LRU eviction<br/>(pool cap: 500)"] --> ABORT["agent.abort()<br/>Kill active process"]
        ABORT --> RM["rm -rf sandboxDir<br/>cleanupSandbox()"]

        SESSION_RESET["Session reset"] --> ABORT
    end

    WRITE_RULES --> SPAWN

    style RULES fill:#fff3e6,stroke:#333,stroke-width:2px
    style FORBIDDEN fill:#ffe6e6,stroke:#333
    style DESTRUCTIVE fill:#ffe6e6,stroke:#333
    style ALLOWED fill:#e6ffe6,stroke:#333
```

---

## 12. Runtime Configuration

Admin configuration flow: validate, persist, apply in real-time.

```mermaid
flowchart TD
    ADMIN([Admin: /config key value]) --> PARSE_CMD{Command type?}

    PARSE_CMD -->|No args| SHOW_ALL["Show all settings<br/>Key: value (default)"]
    PARSE_CMD -->|Key only| SHOW_ONE["Show key details<br/>Type, range, current, default"]
    PARSE_CMD -->|"reset"| RESET_ALL["Reset all to defaults<br/>Delete from DB"]
    PARSE_CMD -->|"reset key"| RESET_ONE["Reset key to default<br/>Delete from DB"]
    PARSE_CMD -->|"key value"| VALIDATE

    subgraph VALIDATE["Validation Pipeline"]
        CHECK_KEY{Valid key?} -->|No| KEY_ERR[/"❌ Chiave sconosciuta"/]
        CHECK_KEY -->|Yes| CHECK_TYPE{Value type?}

        CHECK_TYPE -->|number| PARSE_NUM["parseInt(value)"]
        PARSE_NUM --> RANGE_CHECK{In range?<br/>min ≤ v ≤ max}
        RANGE_CHECK -->|No| RANGE_ERR[/"❌ Fuori range"/]
        RANGE_CHECK -->|Yes| VALID

        CHECK_TYPE -->|boolean| PARSE_BOOL["Parse: true/1/yes/si<br/>false/0/no"]
        PARSE_BOOL --> BOOL_OK{Valid?}
        BOOL_OK -->|No| BOOL_ERR[/"❌ Valore non valido"/]
        BOOL_OK -->|Yes| VALID

        CHECK_TYPE -->|string| ENUM_CHECK{Has enum?}
        ENUM_CHECK -->|Yes| IN_ENUM{In allowed values?}
        IN_ENUM -->|No| ENUM_ERR[/"❌ Valore non permesso"/]
        IN_ENUM -->|Yes| VALID
        ENUM_CHECK -->|No| VALID

        CHECK_TYPE -->|"timeout_ms special"| TIMEOUT_CHECK{0 or ≥ 5000?}
        TIMEOUT_CHECK -->|No| TIMEOUT_ERR[/"❌ Minimo 5000ms o 0"/]
        TIMEOUT_CHECK -->|Yes| VALID
    end

    VALID[Validated value] --> PERSIST["db.setConfig(key, value)<br/>INSERT OR REPLACE"]
    PERSIST --> APPLY["applyToConfig(key, value)<br/>Mutate in-memory AgentConfig"]

    APPLY --> SPECIAL{Special handling?}
    SPECIAL -->|log_level| SET_LOG["logger.setMinLevel(level)"]
    SPECIAL -->|Other| DONE

    SET_LOG --> DONE
    DONE --> REPLY["✅ key: oldValue → newValue"]

    RESET_ALL --> CLEAR_DB["db.clearAllConfig()"]
    CLEAR_DB --> RELOAD["Reload defaults<br/>into AgentConfig"]
    RELOAD --> REPLY_RESET["✅ Configurazione ripristinata"]

    style VALIDATE fill:#e6f3ff,stroke:#333,stroke-width:2px
    style PERSIST fill:#f9f,stroke:#333
    style KEY_ERR fill:#f66,stroke:#333
    style RANGE_ERR fill:#f66,stroke:#333
```
