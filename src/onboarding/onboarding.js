/**
 * Onboarding flow controller.
 *
 * Entry point: launchOnboarding(extensionAPI, deps)
 * Teardown:    teardownOnboarding()
 *
 * deps is an object of functions/values injected from index.js
 * to avoid circular imports.
 */

import {
  createOnboardingCard,
  transitionCardContent,
  updateStepIndicator,
  clearTransitionTimers,
} from "./onboarding-ui.js";
import { ONBOARDING_STEPS } from "./onboarding-steps.js";

// Module-scoped state
let onboardingCardEl = null;
let onboardingDestroyFn = null;
let currentStepIndex = 0;
let activeExtensionAPI = null;
let activeDeps = null;
let activeContentArea = null;
let activeStepIndicator = null;
let activeBackLink = null;
// Mutable session state shared across steps (survives async settings timing)
let sessionState = {};

// ---------------------------------------------------------------------------
// Resume logic
// ---------------------------------------------------------------------------

function loadOnboardingState(extensionAPI, deps) {
  const hasName = !!extensionAPI.settings.get(deps.SETTINGS_KEYS.userName);
  const hasKey = !!(
    deps.getSettingString(extensionAPI, deps.SETTINGS_KEYS.anthropicApiKey, "") ||
    deps.getSettingString(extensionAPI, deps.SETTINGS_KEYS.openaiApiKey, "") ||
    deps.getSettingString(extensionAPI, deps.SETTINGS_KEYS.geminiApiKey, "") ||
    deps.getSettingString(extensionAPI, deps.SETTINGS_KEYS.mistralApiKey, "") ||
    deps.getSettingString(extensionAPI, deps.SETTINGS_KEYS.llmApiKey, "")
  );

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
// Back navigation
// ---------------------------------------------------------------------------

/**
 * Walk backward from the given index, skipping steps whose skipIf returns true.
 * Returns the previous visible step index, or -1 if there is none.
 */
function findPreviousVisibleStep(fromIndex) {
  const ctx = {
    extensionAPI: activeExtensionAPI,
    deps: activeDeps,
    advanceStep: () => {},
    skipToEnd: () => {},
    card: onboardingCardEl,
    contentArea: activeContentArea,
    sessionState,
  };
  for (let i = fromIndex - 1; i >= 0; i--) {
    const s = ONBOARDING_STEPS[i];
    if (typeof s.skipIf !== "function" || !s.skipIf(ctx)) {
      return i;
    }
  }
  return -1;
}

function goBack() {
  const prev = findPreviousVisibleStep(currentStepIndex);
  if (prev >= 0) renderStep(prev);
}

// ---------------------------------------------------------------------------
// Step rendering
// ---------------------------------------------------------------------------

function renderStep(stepIndex) {
  if (!activeExtensionAPI || !activeDeps || !activeContentArea) return;

  // Past the last step — finish
  if (stepIndex >= ONBOARDING_STEPS.length) {
    teardownOnboarding();
    return;
  }

  const step = ONBOARDING_STEPS[stepIndex];
  currentStepIndex = stepIndex;

  // Check skip condition
  const ctx = {
    extensionAPI: activeExtensionAPI,
    deps: activeDeps,
    advanceStep: () => renderStep(stepIndex + 1),
    goBack: () => goBack(),
    skipToEnd: () => teardownOnboarding(),
    card: onboardingCardEl,
    contentArea: activeContentArea,
    sessionState,
  };

  if (typeof step.skipIf === "function" && step.skipIf(ctx)) {
    renderStep(stepIndex + 1);
    return;
  }

  // Show/hide back link based on whether there's a previous visible step
  if (activeBackLink) {
    const hasPrev = findPreviousVisibleStep(stepIndex) >= 0;
    activeBackLink.style.display = hasPrev ? "" : "none";
  }

  // Render step content
  const fragment = step.render(ctx);

  // Count visible (non-skipped) steps for the indicator
  const visibleTotal = ONBOARDING_STEPS.filter((s, i) => {
    if (typeof s.skipIf !== "function") return true;
    // Re-check skip conditions with current ctx (step index doesn't matter for skipIf)
    return !s.skipIf(ctx);
  }).length;

  // Calculate visible position (how many non-skipped steps before this one)
  let visiblePosition = 0;
  for (let i = 0; i < stepIndex; i++) {
    const s = ONBOARDING_STEPS[i];
    if (typeof s.skipIf !== "function" || !s.skipIf(ctx)) {
      visiblePosition++;
    }
  }

  transitionCardContent(activeContentArea, fragment);
  updateStepIndicator(activeStepIndicator, visiblePosition, visibleTotal);

  // After content swap: auto-focus first input and wire Enter key to primary button
  setTimeout(() => {
    if (!activeContentArea) return;
    const firstInput = activeContentArea.querySelector(".cos-onboarding-input");
    if (firstInput) firstInput.focus();

    // Remove any previous Enter handler, then attach a fresh one
    if (activeContentArea._onboardingKeyHandler) {
      activeContentArea.removeEventListener("keydown", activeContentArea._onboardingKeyHandler);
    }
    const handler = (e) => {
      if (e.key === "Enter") {
        const primaryBtn = activeContentArea.querySelector(".cos-onboarding-btn--primary");
        if (primaryBtn) { e.preventDefault(); primaryBtn.click(); }
      }
    };
    activeContentArea._onboardingKeyHandler = handler;
    activeContentArea.addEventListener("keydown", handler);
  }, 380);
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
  if (onboardingCardEl) teardownOnboarding();

  activeExtensionAPI = extensionAPI;
  activeDeps = deps;
  sessionState = {};

  const state = loadOnboardingState(extensionAPI, deps);

  const {
    card,
    contentArea,
    stepIndicator,
    backLink,
    destroy,
  } = createOnboardingCard({
    title: deps.getAssistantDisplayName(extensionAPI),
    onBack: () => goBack(),
    onSkip: () => {
      // "Skip" footer link — advance one step
      renderStep(currentStepIndex + 1);
    },
    onDoLater: () => {
      // "Do this later" / close button
      const hasKey = !!(
        deps.getSettingString(extensionAPI, deps.SETTINGS_KEYS.anthropicApiKey, "") ||
        deps.getSettingString(extensionAPI, deps.SETTINGS_KEYS.openaiApiKey, "") ||
        deps.getSettingString(extensionAPI, deps.SETTINGS_KEYS.geminiApiKey, "") ||
        deps.getSettingString(extensionAPI, deps.SETTINGS_KEYS.mistralApiKey, "") ||
        deps.getSettingString(extensionAPI, deps.SETTINGS_KEYS.llmApiKey, "")
      );
      if (hasKey) {
        deps.iziToast.info({
          title: "No worries",
          message: "You can finish setting up any time via the command palette: Chief of Staff: Run Onboarding.",
          timeout: 5000,
          position: "bottomRight",
        });
      } else {
        deps.iziToast.info({
          title: "No worries",
          message: "Without an API key I can\u2019t do much yet. You can add one in Settings \u2192 Chief of Staff.",
          timeout: 5000,
          position: "bottomRight",
        });
      }
      teardownOnboarding();
    },
  });

  onboardingCardEl = card;
  onboardingDestroyFn = destroy;
  activeContentArea = contentArea;
  activeStepIndicator = stepIndicator;
  activeBackLink = backLink;

  document.body.appendChild(card);

  // Start from the resume point
  renderStep(state.currentStep);
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

  clearTransitionTimers();

  if (onboardingDestroyFn) {
    onboardingDestroyFn();
    onboardingDestroyFn = null;
  }

  const card = onboardingCardEl || document.querySelector(".cos-onboarding-card");
  if (card) {
    card.classList.add("cos-onboarding-exit");
    setTimeout(() => {
      card.remove();
    }, 300);
  }

  onboardingCardEl = null;
  activeExtensionAPI = null;
  activeDeps = null;
  activeContentArea = null;
  activeStepIndicator = null;
  activeBackLink = null;
  currentStepIndex = 0;
  sessionState = {};
}

/**
 * Check if onboarding is currently showing.
 */
export function isOnboardingActive() {
  return !!(onboardingCardEl && document.body.contains(onboardingCardEl));
}
