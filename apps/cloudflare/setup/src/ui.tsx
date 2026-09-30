import type { ComponentChildren, JSX } from "preact";
import { useEffect, useId, useRef, useState } from "preact/hooks";

const ICONS: Record<string, JSX.Element> = {
  overview: (
    <>
      <path d="M3 11l9-8 9 8" />
      <path d="M5 10v10h14V10" />
    </>
  ),
  plan: (
    <>
      <rect x="2" y="5" width="20" height="14" rx="2" />
      <path d="M2 10h20" />
    </>
  ),
  computer: (
    <>
      <rect x="3" y="4" width="18" height="12" rx="2" />
      <path d="M8 20h8" />
      <path d="M12 16v4" />
    </>
  ),
  ai: <path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z" />,
  search: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </>
  ),
  apps: (
    <>
      <path d="M9 2v6" />
      <path d="M15 2v6" />
      <path d="M6 8h12v4a6 6 0 0 1-12 0z" />
      <path d="M12 18v4" />
    </>
  ),
  accounts: (
    <>
      <circle cx="7.5" cy="15.5" r="4.5" />
      <path d="m11 12 9-9" />
      <path d="m16 7 3 3" />
    </>
  ),
  back: <path d="m15 18-6-6 6-6" />,
  chevron: <path d="m6 9 6 6 6-6" />,
  warning: (
    <>
      <path d="M12 9v4" />
      <path d="M12 17h.01" />
      <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
    </>
  ),
  lock: (
    <>
      <rect x="4" y="11" width="16" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </>
  ),
  menu: (
    <>
      <path d="M4 6h16" />
      <path d="M4 12h16" />
      <path d="M4 18h16" />
    </>
  ),
  close: (
    <>
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </>
  ),
  check: <path d="M20 6 9 17l-5-5" />,
};

export function Icon({ name, size = 18 }: { name: string; size?: number }) {
  return (
    <svg
      class="icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      {ICONS[name]}
    </svg>
  );
}

export type Tone = "ok" | "warn" | "bad" | "ready" | "neutral";

export function Pill({
  tone,
  children,
}: {
  tone: Tone;
  children: ComponentChildren;
}) {
  return <span class={`pill ${tone}`}>{children}</span>;
}

export function Soon() {
  return <Pill tone="neutral">Coming soon</Pill>;
}

export function Segmented<T extends string>(props: {
  label: string;
  value: T;
  options: { value: T; label: string; disabled?: boolean }[];
  onChange: (value: T) => void;
  stretch?: boolean;
}) {
  return (
    <div
      class={`seg${props.stretch ? " stretch" : ""}`}
      role="group"
      aria-label={props.label}
    >
      {props.options.map((option) => (
        <button
          type="button"
          key={option.value}
          class={option.value === props.value ? "on" : ""}
          aria-pressed={option.value === props.value}
          disabled={option.disabled}
          onClick={() => props.onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function PageHead(props: {
  title: string;
  lede: string;
  children?: ComponentChildren;
}) {
  return (
    <div class="pagehead">
      <div class="stack-6">
        <h1 class="h1">{props.title}</h1>
        <p class="body muted">{props.lede}</p>
      </div>
      {props.children}
    </div>
  );
}

export function Notice(props: {
  tone: "bad" | "info";
  title?: string;
  children: ComponentChildren;
  action?: ComponentChildren;
}) {
  return (
    <div
      class={`card notice ${props.tone}`}
      role={props.tone === "bad" ? "alert" : undefined}
    >
      <Icon name={props.tone === "bad" ? "warning" : "lock"} size={20} />
      <div class="grow stack-4">
        {props.title ? <span class="notice-title">{props.title}</span> : null}
        <span class="body muted">{props.children}</span>
      </div>
      {props.action}
    </div>
  );
}

/** A plain error line under whatever failed. */
export function Problem({ message }: { message?: string | undefined }) {
  if (!message) return null;
  return (
    <p class="problem" role="alert">
      {message}
    </p>
  );
}

/**
 * Runs one press at a time and keeps what went wrong in words: a button
 * that is busy says so, and a failure stays under it until the next press.
 */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string>();
  const run = async (work: () => Promise<unknown>) => {
    if (busy) return false;
    setBusy(true);
    setProblem(undefined);
    try {
      await work();
      return true;
    } catch (error) {
      setProblem(
        error instanceof Error ? error.message : "That didn’t work. Try again.",
      );
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { busy, problem, run, setProblem };
}

/** A modal dialog: the page's own `<dialog>`, so focus and Escape behave. */
export function Dialog(props: {
  title: string;
  onClose: () => void;
  children: ComponentChildren;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);
  return (
    <dialog
      ref={ref}
      class={`dialog${props.wide ? " wide" : ""}`}
      aria-labelledby={titleId}
      onClose={props.onClose}
      onCancel={(event) => {
        event.preventDefault();
        props.onClose();
      }}
    >
      <div class="dialog-head">
        <h2 class="h2" id={titleId}>
          {props.title}
        </h2>
        <button
          type="button"
          class="btn icon-only"
          aria-label="Close"
          onClick={props.onClose}
        >
          <Icon name="close" />
        </button>
      </div>
      <div class="dialog-body">{props.children}</div>
    </dialog>
  );
}

export function Field(props: {
  label: string;
  hint?: string;
  type?: "text" | "password" | "url";
  value: string;
  onInput: (value: string) => void;
  placeholder?: string;
  required?: boolean;
  autoFocus?: boolean;
  mono?: boolean;
}) {
  const id = useId();
  const hint = useId();
  return (
    <div class="field">
      <label for={id}>{props.label}</label>
      <input
        id={id}
        class={props.mono ? "mono" : ""}
        type={props.type ?? "text"}
        value={props.value}
        placeholder={props.placeholder}
        required={props.required}
        autoFocus={props.autoFocus}
        autoComplete={props.type === "password" ? "new-password" : "off"}
        spellcheck={false}
        aria-describedby={props.hint ? hint : undefined}
        onInput={(event) => props.onInput(event.currentTarget.value)}
      />
      {props.hint ? (
        <span class="small" id={hint}>
          {props.hint}
        </span>
      ) : null}
    </div>
  );
}

/** The one-letter tile an app or a server wears until it has a picture. */
export function Monogram({ name }: { name: string }) {
  return (
    <span class="monogram" aria-hidden="true">
      {name.trim().charAt(0).toUpperCase() || "?"}
    </span>
  );
}
