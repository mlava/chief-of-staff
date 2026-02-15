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

// ---------------------------------------------------------------------------
// Resume logic
// ---------------------------------------------------------------------------

function loadOnboardingState(extensionAPI, deps) {
  const hasName = !!extensionAPI.settings.get(deps.SETTINGS_KEYS.userName);
  const hasKey = !!(
    deps.getSettingString(extensionAPI, deps.SETTINGS_KEYS.anthropicApiKey, "") ||
    deps.getSettingString(extensionAPI, deps.SETTINGS_KEYS.openaiApiKey, "") ||
    deps.getSettingString(extensionAPI, deps.SETTINGS_KEYS.llmApiKey, "")
  );
  if (!hasName && !hasKey) return { currentStep: 0 };
  if (hasName && !hasKey) return { currentStep: 2 };
  if (hasKey) return { currentStep: 3 };
  return { currentStep: 0 };
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
    skipToEnd: () => teardownOnboarding(),
    card: onboardingCardEl,
    contentArea: activeContentArea,
  };

  if (typeof step.skipIf === "function" && step.skipIf(ctx)) {
    renderStep(stepIndex + 1);
    return;
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

  const state = loadOnboardingState(extensionAPI, deps);

  const {
    card,
    contentArea,
    stepIndicator,
    destroy,
  } = createOnboardingCard({
    title: deps.getAssistantDisplayName(extensionAPI),
    onSkip: () => {
      // "Skip" footer link — advance one step
      renderStep(currentStepIndex + 1);
    },
    onDoLater: () => {
      // "Do this later" / close button
      deps.iziToast.info({
        title: "No worries",
        message: "Without an API key I can\u2019t do much yet. You can add one in Settings \u2192 Chief of Staff.",
        timeout: 5000,
        position: "bottomRight",
      });
      teardownOnboarding();
    },
  });

  onboardingCardEl = card;
  onboardingDestroyFn = destroy;
  activeContentArea = contentArea;
  activeStepIndicator = stepIndicator;

  document.body.appendChild(card);

  // Start from the resume point
  renderStep(state.currentStep);
}

/**
 * Remove the onboarding card from the DOM with exit animation.
 */
export function teardownOnboarding() {
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
  currentStepIndex = 0;
}

/**
 * Check if onboarding is currently showing.
 */
export function isOnboardingActive() {
  return !!(onboardingCardEl && document.body.contains(onboardingCardEl));
}
