/**
 * `@frockbot/applet-sdk/kit` — the only components an Applet renders.
 *
 * Fourteen components on nine semantic tokens. They are versioned once here
 * and never copied into an Applet (ADR 0022 decision 10), which is why the
 * linter forbids raw colours and the props below are the whole vocabulary.
 * `kit/README.md` is the reference the Bot reads.
 */

import {
  useEffect,
  useRef,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";

import { installKitStyles } from "./styles.js";

export { KIT_CSS, installKitStyles } from "./styles.js";

installKitStyles();

type Space = "none" | "small" | "medium" | "large";

const SPACE: Record<Space, string> = {
  none: "0",
  small: "4px",
  medium: "8px",
  large: "16px",
};

function classes(...values: Array<string | false | undefined>): string {
  return values.filter(Boolean).join(" ");
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

export interface StackProps {
  children?: ReactNode;
  direction?: "row" | "column";
  gap?: Space;
  align?: "start" | "center" | "end" | "stretch";
  justify?: "start" | "center" | "end" | "between";
  wrap?: boolean;
  /** Adds the kit's root class; put one at the top of the page. */
  root?: boolean;
  className?: string;
}

export function Stack({
  children,
  direction = "column",
  gap = "medium",
  align,
  justify,
  wrap,
  root,
  className,
}: StackProps) {
  return (
    <div
      className={classes("fb-stack", root && "fb-root", className)}
      data-direction={direction}
      data-align={align}
      data-justify={justify}
      data-wrap={wrap ? "true" : undefined}
      style={{ gap: SPACE[gap], ...(root ? { padding: "12px" } : null) }}
    >
      {children}
    </div>
  );
}

export interface TextProps {
  children?: ReactNode;
  size?: "title" | "heading" | "body" | "small";
  tone?: "default" | "muted";
  as?: "p" | "span" | "div" | "h1" | "h2" | "h3";
  className?: string;
}

export function Text({
  children,
  size = "body",
  tone = "default",
  as: Tag = "p",
  className,
}: TextProps) {
  return (
    <Tag
      className={classes("fb-text", className)}
      data-size={size}
      data-tone={tone}
    >
      {children}
    </Tag>
  );
}

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

export interface ButtonProps extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "className" | "style"
> {
  children?: ReactNode;
  variant?: "default" | "primary" | "ghost";
}

export function Button({
  children,
  variant = "default",
  type = "button",
  ...rest
}: ButtonProps) {
  return (
    <button className="fb-button" data-variant={variant} type={type} {...rest}>
      {children}
    </button>
  );
}

interface FieldProps {
  label?: string;
  error?: string;
  children: ReactNode;
}

function Field({ label, error, children }: FieldProps) {
  return (
    <label className="fb-field">
      {label ? <span className="fb-label">{label}</span> : null}
      {children}
      {error ? <span className="fb-error">{error}</span> : null}
    </label>
  );
}

export interface InputProps extends Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "className" | "style" | "onChange" | "type"
> {
  label?: string;
  error?: string;
  /** Receives the value, not the event. */
  onValueChange?: (value: string) => void;
}

export function Input({ label, error, onValueChange, ...rest }: InputProps) {
  return (
    <Field label={label} error={error}>
      <input
        className="fb-control"
        type="text"
        onChange={(event) => onValueChange?.(event.target.value)}
        {...rest}
      />
    </Field>
  );
}

export interface TextareaProps extends Omit<
  TextareaHTMLAttributes<HTMLTextAreaElement>,
  "className" | "style" | "onChange"
> {
  label?: string;
  error?: string;
  onValueChange?: (value: string) => void;
}

export function Textarea({
  label,
  error,
  onValueChange,
  ...rest
}: TextareaProps) {
  return (
    <Field label={label} error={error}>
      <textarea
        className="fb-control"
        onChange={(event) => onValueChange?.(event.target.value)}
        {...rest}
      />
    </Field>
  );
}

export interface SelectOption {
  value: string;
  label: string;
}

export interface SelectProps extends Omit<
  SelectHTMLAttributes<HTMLSelectElement>,
  "className" | "style" | "onChange" | "children"
> {
  label?: string;
  error?: string;
  options: SelectOption[];
  onValueChange?: (value: string) => void;
}

export function Select({
  label,
  error,
  options,
  onValueChange,
  ...rest
}: SelectProps) {
  return (
    <Field label={label} error={error}>
      <select
        className="fb-control"
        onChange={(event) => onValueChange?.(event.target.value)}
        {...rest}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </Field>
  );
}

export interface CheckboxProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label?: ReactNode;
  disabled?: boolean;
  /** Announced when there is no visible label. */
  ariaLabel?: string;
}

export function Checkbox({
  checked,
  onChange,
  label,
  disabled,
  ariaLabel,
}: CheckboxProps) {
  return (
    <label
      className="fb-checkbox"
      data-disabled={disabled ? "true" : undefined}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        aria-label={label === undefined ? ariaLabel : undefined}
        onChange={(event) => onChange(event.target.checked)}
      />
      {label === undefined ? null : <span>{label}</span>}
    </label>
  );
}

// ---------------------------------------------------------------------------
// Surfaces
// ---------------------------------------------------------------------------

export interface CardProps {
  children?: ReactNode;
  title?: ReactNode;
}

export function Card({ children, title }: CardProps) {
  return (
    <section className="fb-card">
      {title === undefined ? null : (
        <div className="fb-card-title">{title}</div>
      )}
      {children}
    </section>
  );
}

export interface ToolbarProps {
  children?: ReactNode;
  /** Renders flush to the trailing edge, after a flexible spacer. */
  end?: ReactNode;
}

export function Toolbar({ children, end }: ToolbarProps) {
  return (
    <div className="fb-toolbar">
      {children}
      {end === undefined ? null : (
        <>
          <span className="fb-toolbar-spacer" />
          {end}
        </>
      )}
    </div>
  );
}

export interface ListProps {
  children?: ReactNode;
  /** Hairline between rows. Defaults to true. */
  bordered?: boolean;
}

export function List({ children, bordered = true }: ListProps) {
  return (
    <ul className="fb-list" data-bordered={bordered ? "true" : "false"}>
      {children}
    </ul>
  );
}

export interface ListItemProps {
  children?: ReactNode;
  /** Leading slot: a checkbox, a badge, an avatar. */
  start?: ReactNode;
  /** Trailing slot: actions. */
  end?: ReactNode;
  onClick?: () => void;
}

export function ListItem({ children, start, end, onClick }: ListItemProps) {
  return (
    <li
      className="fb-list-item"
      data-interactive={onClick ? "true" : undefined}
      onClick={onClick}
    >
      {start}
      <div className="fb-list-item-body">{children}</div>
      {end === undefined ? null : <div className="fb-list-item-end">{end}</div>}
    </li>
  );
}

export interface BadgeProps {
  children?: ReactNode;
  tone?: "default" | "accent";
}

export function Badge({ children, tone = "default" }: BadgeProps) {
  return (
    <span className="fb-badge" data-tone={tone}>
      {children}
    </span>
  );
}

export interface EmptyStateProps {
  title: string;
  description?: string;
  action?: ReactNode;
}

export function EmptyState({ title, description, action }: EmptyStateProps) {
  return (
    <div className="fb-empty">
      <div className="fb-empty-title">{title}</div>
      {description === undefined ? null : <div>{description}</div>}
      {action}
    </div>
  );
}

export interface DialogProps {
  open: boolean;
  title?: ReactNode;
  onClose: () => void;
  children?: ReactNode;
  /** Buttons for the trailing action row. */
  actions?: ReactNode;
}

export function Dialog({
  open,
  title,
  onClose,
  children,
  actions,
}: DialogProps) {
  const surface = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    surface.current?.focus();
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div
      className="fb-dialog-backdrop fb-root"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="fb-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === "string" ? title : undefined}
        tabIndex={-1}
        ref={surface}
      >
        {title === undefined ? null : (
          <div className="fb-dialog-title">{title}</div>
        )}
        {children}
        {actions === undefined ? null : (
          <div className="fb-dialog-actions">{actions}</div>
        )}
      </div>
    </div>
  );
}
