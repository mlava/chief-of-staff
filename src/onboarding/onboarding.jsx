/** @jsx h */
/** @jsxFrag Frag */
/**
 * Onboarding flow controller (React 18, mounted with window.ReactDOM).
 *
 * Entry point: launchOnboarding(extensionAPI, deps)
 * Teardown:    teardownOnboarding()
 * Query:       isOnboardingActive()
 *
 * deps is an object of functions/values injected from index.js to avoid
 * circular imports.
 *
 * React/ReactDOM/Blueprint come from Roam at runtime — nothing in this module
 * touches window/document at import time (tests import it under plain node).
 */

import { h, OnboardingCard, focusFirstInput } from "./onboarding-ui.jsx";
import { ONBOARDING_STEPS } from "./onboarding-steps.jsx";

// ── Module-scoped state ──────────────────────────────────────────────────────
let onboardingRoot = null;       // ReactDOM root
let onboardingContainer = null;  // host <div> appended to document.body
let onboardingCardEl = null;     // .cos-onboarding-card element
let activeExtensionAPI = null;
let activeDeps = null;
let currentStepIndex = 0;
let setStepIndexRef = null;      // OnboardingApp's setState, published on mount
// Mutable session state shared across steps (survives async settings timing)
let sessionState = {};

// ---------------------------------------------------------------------------
// Resume logic
// ---------------------------------------------------------------------------

function loadOnboardingState(extensionAPI, deps) {
  const hasName = !!extensionAPI.settings.get(deps.SETTINGS_KEYS.userName);
  // Any configured LLM path counts: built-in/legacy key, ChatGPT
  // subscription, or a custom slot.
  const hasKey = !!deps.hasAnyLlmConfigured?.(extensionAPI);

  // Check for memory and skills pages (user may have set up manually)
  let hasMemory = false;
  let hasSkills = false;
  try {
    const memResult = window.roamAlphaAPI?.data?.pull?.(
      "[:node/title]", '[:node/title "Chief of Staff/Memory"]'
    );
    hasMemory = !!(memResult?.[":node/title"]);
    const skillsResult = window.roamAlphaAPI?.data?.pull?.(
      "[:node/title]", '[:node/title "Chief of Staff/Skills"]'
    );
    hasSkills = !!(skillsResult?.[":node/title"]);
  } catch { /* ignore */ }

  // Walk forward: skip steps whose preconditions are already met
  // Steps: 0=welcome, 1=introductions, 2=api-key, 3=better-tasks,
  //        4=memory-pages, 5=memory-questionnaire, 6=hotkey,
  //        7=chat-panel, 8=skills, 9=composio, 10=local-mcp, 11=finish
  if (!hasName && !hasKey) return { currentStep: 0 };
  if (hasName && !hasKey) return { currentStep: 2 };
  // Has key — skip past intro/key steps
  if (hasMemory && hasSkills) return { currentStep: 9 }; // Jump to composio/local-mcp/finish
  if (hasMemory) return { currentStep: 8 }; // Jump to skills
  return { currentStep: 3 }; // Start from better-tasks
}

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

/**
 * ctx used purely for evaluating skipIf() during navigation bookkeeping.
 * skipIf implementations must stay pure/DOM-free, so the no-op callbacks here
 * are never invoked.
 */
function navContext() {
  return {
    extensionAPI: activeExtensionAPI,
    deps: activeDeps,
    advanceStep: () => {},
    goBack: () => {},
    skipToEnd: () => {},
    sessionState,
  };
}

function isStepSkipped(step, ctx) {
  return !!(step && typeof step.skipIf === "function" && step.skipIf(ctx));
}

/**
 * First index >= fromIndex whose step is not skipped.
 * Returns ONBOARDING_STEPS.length when there is none (i.e. flow is finished).
 */
function findNextVisibleStep(fromIndex) {
  const ctx = navContext();
  for (let i = Math.max(0, fromIndex); i < ONBOARDING_STEPS.length; i++) {
    if (!isStepSkipped(ONBOARDING_STEPS[i], ctx)) return i;
  }
  return ONBOARDING_STEPS.length;
}

/**
 * Walk backward from the given index, skipping steps whose skipIf returns true.
 * Returns the previous visible step index, or -1 if there is none.
 */
function findPreviousVisibleStep(fromIndex) {
  const ctx = navContext();
  for (let i = fromIndex - 1; i >= 0; i--) {
    if (!isStepSkipped(ONBOARDING_STEPS[i], ctx)) return i;
  }
  return -1;
}

/** Visible position (0-based) of stepIndex and the visible step count. */
function computeStepPosition(stepIndex) {
  const ctx = navContext();
  let visibleTotal = 0;
  let visiblePosition = 0;
  for (let i = 0; i < ONBOARDING_STEPS.length; i++) {
    const skipped = isStepSkipped(ONBOARDING_STEPS[i], ctx);
    if (!skipped) {
      visibleTotal++;
      if (i < stepIndex) visiblePosition++;
    }
  }
  return { visiblePosition, visibleTotal };
}

/** Move forward to `index`, skipping steps whose skipIf is satisfied. */
function goToStep(index) {
  if (!activeExtensionAPI || !activeDeps) return;
  const target = findNextVisibleStep(index);
  if (target >= ONBOARDING_STEPS.length) {
    // Past the last step — finish
    teardownOnboarding();
    return;
  }
  currentStepIndex = target;
  if (typeof setStepIndexRef === "function") setStepIndexRef(target);
}

/** Move back one visible step (no-op on the first visible step). */
function goBack() {
  if (!activeExtensionAPI || !activeDeps) return;
  const prev = findPreviousVisibleStep(currentStepIndex);
  if (prev < 0) return;
  currentStepIndex = prev;
  if (typeof setStepIndexRef === "function") setStepIndexRef(prev);
}

/** "Do this later" footer link and header close button. */
function doThisLater() {
  const extensionAPI = activeExtensionAPI;
  const deps = activeDeps;
  if (deps?.iziToast) {
    const hasKey = !!deps.hasAnyLlmConfigured?.(extensionAPI);
    if (hasKey) {
      deps.iziToast.info({
        class: "cos-toast",
        title: "No worries",
        message: "You can finish setting up any time via the command palette: Chief of Staff: Run Onboarding.",
        timeout: 5000,
        position: "bottomRight",
      });
    } else {
      deps.iziToast.info({
        class: "cos-toast",
        title: "No worries",
        message: "Without an AI model connected I can\u2019t do much yet. You can connect one in Settings \u2192 Chief of Staff, or re-run onboarding from the command palette.",
        timeout: 5000,
        position: "bottomRight",
      });
    }
  }
  teardownOnboarding();
}

// ---------------------------------------------------------------------------
// Root component
// ---------------------------------------------------------------------------

function OnboardingApp(props) {
  const React = window.React;
  const { useState, useEffect, useRef } = React;
  const [stepIndex, setStepIndex] = useState(props.initialStep || 0);
  const cardRef = useRef(null);

  // Publish the state setter + card element to the module-level controller.
  useEffect(() => {
    setStepIndexRef = setStepIndex;
    onboardingCardEl = cardRef.current;
    return () => {
      if (setStepIndexRef === setStepIndex) setStepIndexRef = null;
    };
  }, []);

  // Enter triggers the current view's primary action.
  useEffect(() => {
    const card = cardRef.current;
    if (!card) return undefined;
    const handler = (e) => {
      if (e.key !== "Enter" || e.isComposing) return;
      // Only intercept Enter inside the content area — the header close
      // button and footer links keep their own Enter behavior.
      const content = card.querySelector(".cos-onboarding-content");
      if (!content || !content.contains(e.target)) return;
      const primaryBtn = content.querySelector("[data-cos-primary]");
      if (!primaryBtn || primaryBtn.disabled) return;
      e.preventDefault();
      primaryBtn.click();
    };
    card.addEventListener("keydown", handler);
    return () => card.removeEventListener("keydown", handler);
  }, []);

  // Auto-focus the first input shortly after each step renders.
  useEffect(() => {
    const id = setTimeout(() => {
      const card = cardRef.current;
      if (!card) return;
      focusFirstInput(card.querySelector(".cos-onboarding-content") || card);
    }, 380);
    return () => clearTimeout(id);
  }, [stepIndex]);

  const step = ONBOARDING_STEPS[stepIndex];
  if (!step) return null;

  const StepComponent = step.Component;
  const { visiblePosition, visibleTotal } = computeStepPosition(stepIndex);

  const ctx = {
    extensionAPI: activeExtensionAPI,
    deps: activeDeps,
    advanceStep: () => goToStep(stepIndex + 1),
    goBack: () => goBack(),
    skipToEnd: () => teardownOnboarding(),
    sessionState,
  };

  let title = "Chief of Staff";
  try {
    title = activeDeps?.getAssistantDisplayName?.(activeExtensionAPI) || title;
  } catch { /* keep the default */ }

  return (
    <OnboardingCard
      title={title}
      cardRef={cardRef}
      contentKey={step.id || String(stepIndex)}
      showBack={findPreviousVisibleStep(stepIndex) >= 0}
      stepCurrent={visiblePosition}
      stepTotal={visibleTotal}
      onBack={() => goBack()}
      // "Skip" footer link — advance one step
      onSkip={() => goToStep(stepIndex + 1)}
      onDoLater={() => doThisLater()}
    >
      {StepComponent ? <StepComponent ctx={ctx} /> : null}
    </OnboardingCard>
  );
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Launch the onboarding flow. Call from onload() or command palette.
 * @param {object} extensionAPI — Roam Depot extensionAPI
 * @param {object} deps — injected dependencies from index.js
 */
export function launchOnboarding(extensionAPI, deps) {
  // If already active, tear down first (re-run case)
  if (onboardingContainer || onboardingRoot) teardownOnboarding();

  const win = typeof window !== "undefined" ? window : null;
  const ReactDOM = win ? win.ReactDOM : null;
  if (!win || !win.React || typeof ReactDOM?.createRoot !== "function") {
    console.error("[Chief of Staff] Onboarding needs Roam's React 18 runtime (window.React / window.ReactDOM).");
    return;
  }

  activeExtensionAPI = extensionAPI;
  activeDeps = deps;
  sessionState = {};

  const state = loadOnboardingState(extensionAPI, deps);
  const initialStep = findNextVisibleStep(state.currentStep || 0);
  if (initialStep >= ONBOARDING_STEPS.length) {
    // Everything is already configured — nothing to show.
    activeExtensionAPI = null;
    activeDeps = null;
    return;
  }
  currentStepIndex = initialStep;

  // Hide the Roam Depot settings overlay so onboarding inputs are accessible.
  // React-managed Blueprint portal ignores synthetic close events, so we hide
  // it via CSS and restore on teardown.
  const settingsPortal = document.querySelector(".rm-modal-portal--settings");
  if (settingsPortal) {
    settingsPortal.style.display = "none";
    sessionState._hiddenSettingsPortal = settingsPortal;
  }

  const container = document.createElement("div");
  container.className = "cos-onboarding-root";
  document.body.appendChild(container);
  onboardingContainer = container;

  onboardingRoot = ReactDOM.createRoot(container);
  onboardingRoot.render(<OnboardingApp initialStep={initialStep} />);
}

/**
 * Remove the onboarding card from the DOM with exit animation.
 */
export function teardownOnboarding() {
  // Clear any pending step timers (e.g. hotkey auto-advance)
  if (sessionState._hotkeyTimerId) {
    clearTimeout(sessionState._hotkeyTimerId);
    delete sessionState._hotkeyTimerId;
  }

  // Grab refs before clearing module state
  const hiddenPortal = sessionState._hiddenSettingsPortal;
  const root = onboardingRoot;
  const container = onboardingContainer;
  const card =
    onboardingCardEl ||
    (typeof document !== "undefined" ? document.querySelector(".cos-onboarding-card") : null);

  if (card) card.classList.add("cos-onboarding-exit");

  onboardingRoot = null;
  onboardingContainer = null;
  onboardingCardEl = null;
  activeExtensionAPI = null;
  activeDeps = null;
  setStepIndexRef = null;
  currentStepIndex = 0;
  sessionState = {};

  // Unmount after the exit animation. Deferring also keeps us out of React's
  // render/event phase when teardown is triggered from a button handler.
  const finish = () => {
    if (root) {
      try { root.unmount(); } catch { /* already gone */ }
    }
    if (container && typeof container.remove === "function") container.remove();
    // Restore settings overlay after exit animation so it doesn't flash
    if (hiddenPortal) hiddenPortal.style.display = "";
  };

  if (root || container) setTimeout(finish, card ? 300 : 0);
  else if (hiddenPortal) hiddenPortal.style.display = "";
}

/**
 * Check if onboarding is currently showing.
 */
export function isOnboardingActive() {
  return !!(
    onboardingContainer &&
    typeof document !== "undefined" &&
    document.body.contains(onboardingContainer)
  );
}
