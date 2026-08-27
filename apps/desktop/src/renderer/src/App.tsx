import {
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import {
  chatReducer,
  initialChatState,
  type ChatMessage,
  type ToolActivity,
} from "./chat-state.js";

function connectionLabel(
  connection: typeof initialChatState.connection,
): string {
  if (connection === "ready") return "Pi worker connected";
  if (connection === "starting") return "Starting Pi worker";
  if (connection === "disconnected") return "Pi worker stopped";
  return "Pi worker needs attention";
}

function toolSymbol(status: ToolActivity["status"]): string {
  if (status === "running") return "···";
  if (status === "failed") return "!";
  return "✓";
}

function ToolRow({ tool }: { tool: ToolActivity }) {
  const symbol = toolSymbol(tool.status);
  return (
    <details className={`tool-row tool-${tool.status}`}>
      <summary>
        <span className="tool-symbol">{symbol}</span>
        <span>{tool.name}</span>
      </summary>
      {tool.text ? <pre>{tool.text}</pre> : null}
    </details>
  );
}

function Message({ message }: { message: ChatMessage }) {
  const isUser = message.role === "user";
  return (
    <article
      className={`message ${isUser ? "message-user" : "message-assistant"}`}
    >
      <div className="message-bubble">
        {message.text ? (
          <span>{message.text}</span>
        ) : (
          <span className="typing" aria-label="Thinking">
            <i />
            <i />
            <i />
          </span>
        )}
      </div>
      {message.tools.length > 0 ? (
        <div className="tool-list">
          {message.tools.map((tool) => (
            <ToolRow key={tool.id} tool={tool} />
          ))}
        </div>
      ) : null}
    </article>
  );
}

export function App() {
  const [state, dispatch] = useReducer(chatReducer, initialChatState);
  const [draft, setDraft] = useState("");
  const [contextMenuOpen, setContextMenuOpen] = useState(false);
  const [rightPanelOpen, setRightPanelOpen] = useState(true);
  const threadEnd = useRef<HTMLDivElement>(null);

  useEffect(() => {
    window.frockbot.onAgentEvent((event) =>
      dispatch({ type: "agent-event", event }),
    );
    return () => {
      window.frockbot.clearAgentEventListeners();
    };
  }, []);
  useEffect(() => {
    threadEnd.current?.scrollIntoView({ behavior: "smooth" });
  }, [state.messages]);
  useEffect(() => {
    if (!contextMenuOpen) return;
    const close = () => setContextMenuOpen(false);
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [contextMenuOpen]);

  const activeRunId = state.activeRunId;
  const isRunning = Boolean(activeRunId);
  const canSend =
    state.connection === "ready" && !isRunning && draft.trim().length > 0;
  const modelLabel = useMemo(
    () =>
      state.model
        ? `${state.model.provider} · ${state.model.id}`
        : "Pi · one conversation",
    [state.model],
  );

  async function sendMessage() {
    const text = draft.trim();
    if (!text || !canSend) return;
    const runId = crypto.randomUUID();
    dispatch({ type: "submit", runId, text });
    setDraft("");
    const response = await window.frockbot.sendPrompt({ runId, text });
    if (!response.accepted) {
      dispatch({
        type: "request-rejected",
        runId,
        message: response.error ?? "Pi rejected the prompt",
      });
    }
  }

  function handleComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void sendMessage();
    }
  }

  async function restartWorker() {
    dispatch({ type: "restart" });
    await window.frockbot.restart();
  }

  return (
    <div className={`app-shell ${rightPanelOpen ? "panel-open" : ""}`}>
      <aside className="sidebar">
        <div className="window-controls" aria-hidden="true">
          <i />
          <i />
          <i />
        </div>
        <button className="new-bot" title="New bot" aria-label="New bot">
          +
        </button>
        <label className="search">
          <span>⌕</span>
          <input aria-label="Search bots" placeholder="Search" />
        </label>

        <div className="bot-list">
          <button
            className="bot-row active"
            onContextMenu={(event) => {
              event.preventDefault();
              setContextMenuOpen(true);
            }}
          >
            <span className="bot-icon">⌁</span>
            <span className="bot-copy">
              <strong>Barebones</strong>
              <small>A plain bot, ready to be dressed up.</small>
            </span>
            <time>Now</time>
          </button>
        </div>

        {contextMenuOpen ? (
          <div
            className="context-menu"
            onPointerDown={(event) => event.stopPropagation()}
          >
            <button>
              <span>⚙</span>Bot settings
            </button>
            <button>
              <span>✎</span>Rename
            </button>
            <button>
              <span>⧉</span>Duplicate
            </button>
            <hr />
            <button>
              <span>□</span>Archive
            </button>
            <button className="danger">
              <span>×</span>Delete bot
            </button>
          </div>
        ) : null}

        <div className="sidebar-bottom">
          <button className="plugins">
            <span>⊙</span>Plugins
          </button>
          <button className="profile">
            <span className="profile-face" />
            FrockBot user
          </button>
        </div>
      </aside>

      <main className="workspace">
        <header className="topbar">
          <span className="book-icon">⌁</span>
          <div className="workspace-title">
            <strong>Barebones</strong>
            <small>{modelLabel}</small>
          </div>
          <div className={`connection connection-${state.connection}`}>
            <i />
            {connectionLabel(state.connection)}
          </div>
          <button
            className="icon-button"
            title="Bot settings"
            aria-label="Bot settings"
          >
            ⚙
          </button>
          <button
            className="panel-toggle"
            title={
              rightPanelOpen ? "Hide computer panel" : "Show computer panel"
            }
            aria-label={
              rightPanelOpen ? "Hide computer panel" : "Show computer panel"
            }
            onClick={() => setRightPanelOpen((open) => !open)}
          >
            {rightPanelOpen ? "»" : "«"}
          </button>
        </header>

        <section className="thread" aria-live="polite">
          {state.messages.length === 0 ? (
            <div className="empty-thread">
              <div className="empty-mark">⌁</div>
              <h1>Barebones is ready.</h1>
              <p>
                Start with a conversation. Plugins and outfits can come later.
              </p>
            </div>
          ) : (
            state.messages.map((message) => (
              <Message key={message.id} message={message} />
            ))
          )}
          <div ref={threadEnd} />
        </section>

        {state.error ? (
          <div className="error-banner" role="alert">
            <span>{state.error}</span>
            {state.connection !== "ready" && (
              <button onClick={() => void restartWorker()}>Restart Pi</button>
            )}
          </div>
        ) : null}

        <form
          className="composer"
          onSubmit={(event) => {
            event.preventDefault();
            void sendMessage();
          }}
        >
          <button
            type="button"
            className="add-button"
            aria-label="Add attachment"
          >
            +
          </button>
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={handleComposerKeyDown}
            placeholder={
              state.connection === "ready"
                ? "Message Barebones"
                : "Waiting for Pi…"
            }
            disabled={state.connection !== "ready"}
            rows={1}
          />
          {isRunning && activeRunId ? (
            <button
              type="button"
              className="stop-button"
              onClick={() => void window.frockbot.abort(activeRunId)}
            >
              Stop
            </button>
          ) : (
            <button
              className="send-button"
              type="submit"
              disabled={!canSend}
              aria-label="Send message"
            >
              ↑
            </button>
          )}
        </form>
      </main>

      {rightPanelOpen ? (
        <aside className="right-panel">
          <section>
            <div className="panel-heading">
              <strong>Computer</strong>
              <span>Local</span>
            </div>
            <div className="computer-screen">
              <div className="screen-grid" />
              <span>No computer attached</span>
            </div>
            <p className="screen-label">Barebones computer</p>
          </section>
          <section className="routines-section">
            <div className="panel-heading">
              <strong>Routines</strong>
              <button aria-label="Add routine">+</button>
            </div>
            <div className="routine-empty">
              <span>○</span>
              <div>
                <strong>No routines yet</strong>
                <p>Ask Barebones to repeat something later.</p>
              </div>
            </div>
          </section>
        </aside>
      ) : null}
    </div>
  );
}
