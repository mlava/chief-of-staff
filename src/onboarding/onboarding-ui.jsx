/** @jsx h */
/** @jsxFrag Frag */
/**
 * Onboarding UI kit — React 18 + Blueprint 3, both supplied by Roam at runtime.
 *
 * Hard rules for this file (and for every step that imports it):
 *   • NEVER `import` react / react-dom / @blueprintjs — they come from
 *     `window.React`, `window.ReactDOM`, `window.Blueprint.Core`.
 *   • NEVER touch `window` / `document` at module top level. Tests import this
 *     module under plain node (`node --test`), where neither exists. Every
 *     global access must live inside a function body, i.e. run at render time.
 *   • JSX compiles to the local `h()` / `Frag` below via the `@jsx` /
 *     `@jsxFrag` pragmas at the top of this file (esbuild-loader in webpack,
 *     tsx in tests).
 *
 * Card shell / layout / text blocks keep their `.cos-onboarding-*` classes
 * (styles live in extension.css). Form controls and buttons are Blueprint.
 */

// ---------------------------------------------------------------------------
// Runtime accessors (lazy — nothing here runs at import time)
// ---------------------------------------------------------------------------

/** Roam's React 18. Throws a readable error if the runtime is missing. */
function getReact() {
  const React = typeof window !== "undefined" ? window.React : null;
  if (!React || typeof React.createElement !== "function") {
    throw new Error(
      "[Chief of Staff] window.React is unavailable — the onboarding UI needs Roam's React 18 runtime."
    );
  }
  return React;
}

/**
 * Blueprint 3 core namespace (`window.Blueprint.Core`). Roam guarantees it
 * alongside React (see roamdocs.fyi "Available Libraries"), so a readable
 * throw beats silently rendering unstyled fallbacks.
 */
function getBlueprint() {
  const bp = typeof window !== "undefined" && window.Blueprint ? window.Blueprint.Core : null;
  if (!bp) {
    throw new Error(
      "[Chief of Staff] window.Blueprint.Core is unavailable — the onboarding UI needs Roam's Blueprint runtime."
    );
  }
  return bp;
}

/**
 * `React.createElement`, resolved lazily.
 * @param {string|Function} type
 * @param {object|null} props
 * @param {...any} children
 */
export function h(type, props, ...children) {
  return getReact().createElement(type, props, ...children);
}

/**
 * Fragment component for the JSX transform: `<>…</>` compiles to
 * `h(Frag, null, …)` (see jsxFragment/jsxFragmentFactory in
 * webpack.config.js and tsconfig.json). A wrapper component rather than
 * `React.Fragment` itself so nothing touches `window` at module load.
 */
export function Frag(props) {
  return h(getReact().Fragment, null, props.children);
}

/** Join class names, skipping falsy parts — zero-dep stand-in for clsx. */
export function cx(...parts) {
  return parts.filter(Boolean).join(" ");
}

// ---------------------------------------------------------------------------
// Focus helpers
// ---------------------------------------------------------------------------

/** First focusable text control inside a scope (Blueprint inputs included). */
export const FIRST_INPUT_SELECTOR =
  'input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([disabled]):not([readonly]), textarea:not([disabled])';

/**
 * Focus the first text input inside `scope` (defaults to the onboarding card's
 * content area). Returns true when something was focused.
 */
export function focusFirstInput(scope) {
  let root = scope;
  if (!root) {
    if (typeof document === "undefined") return false;
    root = document.querySelector(".cos-onboarding-content") || document;
  }
  const el = root.querySelector ? root.querySelector(FIRST_INPUT_SELECTOR) : null;
  if (el && typeof el.focus === "function") {
    el.focus();
    return true;
  }
  return false;
}

/**
 * Focus the first input a beat after `deps` change — use it after swapping a
 * sub-view inside a step (the controller only auto-focuses on step change).
 * @param {any[]} deps  dependency array (constant length, as React requires)
 * @param {number} delay ms before focusing (default 50)
 */
export function useAutoFocus(deps = [], delay = 50) {
  const { useEffect } = getReact();
  useEffect(() => {
    const id = setTimeout(() => focusFirstInput(null), delay);
    return () => clearTimeout(id);
  }, deps);
}

/** Ref that flips to false on unmount — guards async callbacks and timers. */
export function useAlive() {
  const { useRef, useEffect } = getReact();
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);
  return alive;
}

// ---------------------------------------------------------------------------
// Text blocks
// ---------------------------------------------------------------------------

/**
 * A block of conversational copy.
 *   h(InfoText, { html: "…<strong>bold</strong>…" })   // markup preserved
 *   h(InfoText, null, "plain text")                    // escaped children
 */
export function InfoText(props) {
  const { html, className, style, children } = props || {};
  if (typeof html === "string") {
    return (
      <div
        className={cx("cos-onboarding-text", className)}
        style={style}
        dangerouslySetInnerHTML={{ __html: html }}
      />
    );
  }
  return <div className={cx("cos-onboarding-text", className)} style={style}>{children}</div>;
}

/**
 * Hint / small-print box — Blueprint Callout, keeping `.cos-onboarding-text`
 * so nested <strong>/<small>/<a> copy stays styled.
 *   h(Hint, { html: "<small>Your key is stored locally…</small>" })
 */
export function Hint(props) {
  const { html, children, intent, icon = null, title, className, style } = props || {};
  const { Callout } = getBlueprint();
  const body = typeof html === "string"
    ? <span dangerouslySetInnerHTML={{ __html: html }} />
    : children;
  return (
    <Callout
      className={cx("cos-onboarding-text", "cos-onboarding-hint", className)}
      style={style}
      intent={intent}
      icon={icon}
      title={title}
    >
      {body}
    </Callout>
  );
}

/** Bulleted list. Items are HTML strings (or React nodes). */
export function BulletList(props) {
  const items = (props && props.items) || [];
  return (
    <ul className="cos-onboarding-list">
      {items
        .filter((i) => i != null)
        .map((item, i) =>
          typeof item === "string"
            ? <li key={i} dangerouslySetInnerHTML={{ __html: item }} />
            : <li key={i}>{item}</li>
        )}
    </ul>
  );
}

/** Inline validation error. Renders nothing when `message` is empty. */
export function InlineError(props) {
  const message = typeof props === "string" ? props : props && props.message;
  if (!message) return null;
  return <div className="cos-onboarding-error">{String(message)}</div>;
}

/**
 * Inline-error state for a step.
 * @returns {{error: string|null, setError: Function, clearError: Function, errorNode: any}}
 *   `errorNode` is a ready-to-render <InlineError> (null while there's no error).
 */
export function useInlineError(initial = null) {
  const { useState, useCallback } = getReact();
  const [error, setErrorState] = useState(initial == null ? null : String(initial));
  const setError = useCallback((msg) => setErrorState(msg == null ? null : String(msg)), []);
  const clearError = useCallback(() => setErrorState(null), []);
  return { error, setError, clearError, errorNode: <InlineError message={error} /> };
}

// ---------------------------------------------------------------------------
// Form controls (Blueprint)
// ---------------------------------------------------------------------------

function assignRef(ref, el) {
  if (typeof ref === "function") ref(el);
  else if (ref && typeof ref === "object") ref.current = el;
}

/**
 * Labelled text/password field — Blueprint InputGroup in `.cos-onboarding-field`.
 *
 * Controlled:   h(Field, { label, value, onChange: (e) => setValue(e.target.value) })
 * Uncontrolled: h(Field, { label, value: initialValue, inputRef })  // read inputRef.current.value
 *
 * @param {object} props
 * @param {string} [props.label]
 * @param {string} [props.placeholder]
 * @param {string} [props.value]        controlled value, or initial value when no onChange
 * @param {string} [props.type]         "text" (default) | "password" | …
 * @param {Function} [props.onChange]   makes the input controlled
 * @param {object|Function} [props.inputRef]  ref object or callback → the <input>
 */
export function Field(props) {
  const {
    label,
    placeholder = "",
    value,
    defaultValue,
    type = "text",
    onChange,
    onKeyDown,
    inputRef,
    disabled,
    className,
    style,
    intent,
    fill = true,
    rightElement,
  } = props || {};
  const { InputGroup } = getBlueprint();
  const setRef = (el) => assignRef(inputRef, el);

  const shared = { type, placeholder, disabled, onKeyDown, intent };
  const valueProps = onChange
    ? { value: value == null ? "" : value, onChange }
    : { defaultValue: defaultValue != null ? defaultValue : value == null ? "" : value };

  const input = (
    <InputGroup
      {...shared}
      {...valueProps}
      className={cx("cos-onboarding-input-group", className)}
      fill={fill}
      inputRef={setRef}
      rightElement={rightElement}
    />
  );

  return (
    <div className="cos-onboarding-field" style={style}>
      {label ? <label className="cos-onboarding-label">{label}</label> : null}
      {input}
    </div>
  );
}

/**
 * Dropdown — Blueprint HTMLSelect. `options` accepts strings or {value,label}.
 * With a `label` it renders as an inline row (label + select).
 *   h(Select, { label: "Provider:", options: ["mistral","openai"], value, onChange })
 */
export function Select(props) {
  const { label, options = [], value, onChange, disabled, className, style, fill } = props || {};
  const { HTMLSelect } = getBlueprint();
  const normalized = options.map((o) => (typeof o === "string" ? { value: o, label: o } : o));

  const select = (
    <HTMLSelect
      options={normalized}
      value={value}
      onChange={onChange}
      disabled={disabled}
      fill={fill}
      className={cx("cos-onboarding-select-wrap", className)}
    />
  );

  if (!label) return select;
  return (
    <div className="cos-onboarding-field cos-onboarding-field--inline" style={style}>
      <label className="cos-onboarding-label">{label}</label>
      {select}
    </div>
  );
}

/**
 * Row of buttons — Blueprint Buttons in a `.cos-onboarding-buttons` flex row.
 * Each button: { label, primary?, disabled?, loading?, onClick, key?, title? }.
 *
 * Primary buttons carry data-cos-primary="true"; the controller's Enter-key
 * handler clicks the first `[data-cos-primary]` inside the card. Keep exactly
 * one primary button visible per view.
 */
export function Buttons(props) {
  const list = ((props && props.buttons) || []).filter(Boolean);
  const { Button } = getBlueprint();
  return (
    <div className="cos-onboarding-buttons">
      {list.map((b, i) => {
        const common = {
          // Positional keys: label-derived keys would remount (and drop focus) on label swaps.
          key: b.key || `btn-${i}`,
          onClick: b.onClick,
          disabled: !!b.disabled,
          title: b.title,
          "data-cos-primary": b.primary ? "true" : undefined,
        };
        return (
          <Button
            {...common}
            className={b.className}
            intent={b.primary ? "primary" : undefined}
            loading={!!b.loading}
            text={b.label}
          />
        );
      })}
    </div>
  );
}

/**
 * Vertical stack of large clickable option cards.
 * Each option: { title, description, onClick, key? }.
 */
export function OptionCards(props) {
  const options = ((props && props.options) || []).filter(Boolean);
  return (
    <div className="cos-onboarding-options">
      {options.map((o, i) => (
        <button
          key={o.key || o.title || i}
          type="button"
          className="cos-onboarding-option"
          onClick={o.onClick}
        >
          <span className="cos-onboarding-option-title">{o.title}</span>
          {o.description ? <span className="cos-onboarding-option-desc">{o.description}</span> : null}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Summary (finish step)
// ---------------------------------------------------------------------------

/** Wrapper for a list of <SummaryItem>s. */
export function Summary(props) {
  return <div className="cos-onboarding-summary">{props && props.children}</div>;
}

/** One checklist row: ✓ when `status` is truthy, – otherwise. */
export function SummaryItem(props) {
  const { label, status } = props || {};
  return (
    <div className="cos-onboarding-summary-item">
      <span className={status ? "cos-onboarding-summary-check" : "cos-onboarding-summary-pending"}>
        {status ? "\u2713" : "\u2013"}
      </span>
      <span>{` ${label}`}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Card shell
// ---------------------------------------------------------------------------

/**
 * The onboarding card: draggable header (title + close), animated content area,
 * footer (back link / do-this-later / skip / step indicator).
 *
 * Rendered by the controller only — steps render *into* it as `children`.
 *
 * @param {object} props
 * @param {string} props.title
 * @param {object|Function} [props.cardRef] ref to the card element
 * @param {string} [props.contentKey]  changes → content remounts + re-animates
 * @param {boolean} [props.showBack]
 * @param {Function} [props.onBack]
 * @param {Function} [props.onSkip]
 * @param {Function} [props.onDoLater]
 * @param {number} [props.stepCurrent] zero-based visible position
 * @param {number} [props.stepTotal]   visible step count
 */
export function OnboardingCard(props) {
  const React = getReact();
  const { useEffect, useRef, useCallback } = React;
  const {
    title = "Chief of Staff",
    cardRef,
    contentKey,
    showBack = false,
    onBack,
    onSkip,
    onDoLater,
    stepCurrent = 0,
    stepTotal = 0,
    children,
  } = props || {};

  const innerRef = useRef(null);
  const dragRef = useRef(null);

  const attachCard = useCallback(
    (el) => {
      innerRef.current = el;
      assignRef(cardRef, el);
    },
    [cardRef]
  );

  // Dragging: move/up listeners live on document so drags survive leaving the card.
  useEffect(() => {
    const onMouseMove = (e) => {
      const state = dragRef.current;
      const card = innerRef.current;
      if (!state || !card) return;
      const dx = e.clientX - state.startX;
      const dy = e.clientY - state.startY;
      // Switch from centred to absolute positioning on first drag
      card.style.transform = "none";
      card.style.left = `${state.origLeft + dx}px`;
      card.style.top = `${state.origTop + dy}px`;
    };
    const onMouseUp = () => {
      dragRef.current = null;
    };
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
    return () => {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
      dragRef.current = null;
    };
  }, []);

  const onHeaderMouseDown = (e) => {
    const card = innerRef.current;
    if (!card) return;
    const target = e.target;
    if (target && typeof target.closest === "function" && target.closest(".cos-onboarding-header-close")) {
      return; // close button — not a drag handle
    }
    dragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      origLeft: card.offsetLeft,
      origTop: card.offsetTop,
    };
    e.preventDefault();
  };

  // <button>, not <a href="#">: these are actions, not navigation — correct
  // semantics for keyboard/screen-reader users (CSS resets the chrome).
  const footerLink = (label, onClick, extraClass) => (
    <button
      type="button"
      className={cx("cos-onboarding-footer-link", extraClass)}
      onClick={onClick}
    >
      {label}
    </button>
  );

  return (
    <div
      // bp3-dark keeps Blueprint controls legible on the dark card whatever
      // Roam's active theme is. Entrance is a pure CSS mount animation.
      className="cos-onboarding-card bp3-dark"
      ref={attachCard}
    >
      <div className="cos-onboarding-header" onMouseDown={onHeaderMouseDown}>
        <span className="cos-onboarding-header-title">{title}</span>
        <button
          type="button"
          className="cos-onboarding-header-close"
          title="Close onboarding"
          onClick={() => {
            if (typeof onDoLater === "function") onDoLater();
          }}
        >
          {"\u00d7"}
        </button>
      </div>
      {/* Keyed by step so each swap mounts a fresh node and re-runs the enter animation. */}
      <div key={contentKey} className="cos-onboarding-content cos-onboarding-content-enter">
        {children}
      </div>
      <div className="cos-onboarding-footer">
        <span className="cos-onboarding-step-indicator">{`${stepCurrent + 1} of ${stepTotal}`}</span>
        {onBack && showBack ? footerLink("\u2190 Back", onBack, "cos-onboarding-back-link") : null}
        <span className="cos-onboarding-footer-links">
          {onDoLater ? footerLink("Do this later", onDoLater) : null}
          {onSkip ? footerLink("Skip", onSkip) : null}
        </span>
      </div>
    </div>
  );
}
