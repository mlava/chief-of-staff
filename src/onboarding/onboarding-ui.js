/**
 * Onboarding UI — card shell, DOM helpers, transitions.
 *
 * All DOM elements use `.cos-onboarding-*` class names.
 * Styles live in extension.css.
 */

// ---------------------------------------------------------------------------
// Card shell
// ---------------------------------------------------------------------------

/**
 * Build the outer onboarding card (header + content area + footer).
 * Returns { card, contentArea, footer, stepIndicator, destroy }.
 */
export function createOnboardingCard({ onSkip, onDoLater, title = "Chief of Staff" } = {}) {
  const card = document.createElement("div");
  card.className = "cos-onboarding-card cos-onboarding-enter";

  // --- Header (draggable) ---
  const header = document.createElement("div");
  header.className = "cos-onboarding-header";

  const headerTitle = document.createElement("span");
  headerTitle.className = "cos-onboarding-header-title";
  headerTitle.textContent = title;
  header.appendChild(headerTitle);

  const closeBtn = document.createElement("button");
  closeBtn.className = "cos-onboarding-header-close";
  closeBtn.textContent = "\u00d7";
  closeBtn.title = "Close onboarding";
  closeBtn.addEventListener("click", () => {
    if (typeof onDoLater === "function") onDoLater();
  });
  header.appendChild(closeBtn);

  // Simple drag behaviour (mirrors chat panel approach)
  let dragState = null;
  const onMouseDown = (e) => {
    if (e.target === closeBtn) return;
    dragState = {
      startX: e.clientX,
      startY: e.clientY,
      origLeft: card.offsetLeft,
      origTop: card.offsetTop,
    };
    e.preventDefault();
  };
  const onMouseMove = (e) => {
    if (!dragState) return;
    const dx = e.clientX - dragState.startX;
    const dy = e.clientY - dragState.startY;
    card.style.left = `${dragState.origLeft + dx}px`;
    card.style.top = `${dragState.origTop + dy}px`;
    card.style.right = "auto";
    card.style.bottom = "auto";
  };
  const onMouseUp = () => { dragState = null; };
  header.addEventListener("mousedown", onMouseDown);
  document.addEventListener("mousemove", onMouseMove);
  document.addEventListener("mouseup", onMouseUp);

  // --- Content area ---
  const contentArea = document.createElement("div");
  contentArea.className = "cos-onboarding-content";

  // --- Footer ---
  const footer = document.createElement("div");
  footer.className = "cos-onboarding-footer";

  const stepIndicator = document.createElement("span");
  stepIndicator.className = "cos-onboarding-step-indicator";
  footer.appendChild(stepIndicator);

  const footerLinks = document.createElement("span");
  footerLinks.className = "cos-onboarding-footer-links";

  if (onDoLater) {
    const doLaterLink = document.createElement("a");
    doLaterLink.className = "cos-onboarding-footer-link";
    doLaterLink.textContent = "Do this later";
    doLaterLink.href = "#";
    doLaterLink.addEventListener("click", (e) => { e.preventDefault(); onDoLater(); });
    footerLinks.appendChild(doLaterLink);
  }

  if (onSkip) {
    const skipLink = document.createElement("a");
    skipLink.className = "cos-onboarding-footer-link";
    skipLink.textContent = "Skip";
    skipLink.href = "#";
    skipLink.addEventListener("click", (e) => { e.preventDefault(); onSkip(); });
    footerLinks.appendChild(skipLink);
  }

  footer.appendChild(footerLinks);

  card.appendChild(header);
  card.appendChild(contentArea);
  card.appendChild(footer);

  const destroy = () => {
    document.removeEventListener("mousemove", onMouseMove);
    document.removeEventListener("mouseup", onMouseUp);
  };

  // Trigger entrance animation on next frame
  requestAnimationFrame(() => {
    card.classList.remove("cos-onboarding-enter");
    card.classList.add("cos-onboarding-visible");
  });

  return { card, contentArea, footer, stepIndicator, destroy };
}

// ---------------------------------------------------------------------------
// Content transitions
// ---------------------------------------------------------------------------

/**
 * Replace contentArea children with the given fragment, animating the swap.
 */
export function transitionCardContent(contentArea, fragment) {
  if (!contentArea) return;
  contentArea.classList.add("cos-onboarding-content-exit");
  const swap = () => {
    contentArea.innerHTML = "";
    contentArea.appendChild(fragment);
    contentArea.classList.remove("cos-onboarding-content-exit");
    contentArea.classList.add("cos-onboarding-content-enter");
    const cleanup = () => {
      contentArea.classList.remove("cos-onboarding-content-enter");
      contentArea.removeEventListener("animationend", cleanup);
    };
    contentArea.addEventListener("animationend", cleanup);
  };
  // Wait for exit animation, or swap immediately if no animation support
  if (contentArea.children.length === 0) {
    swap();
  } else {
    const afterExit = () => {
      contentArea.removeEventListener("animationend", afterExit);
      swap();
    };
    contentArea.addEventListener("animationend", afterExit);
    // Safety fallback if animationend never fires
    setTimeout(() => {
      if (contentArea.classList.contains("cos-onboarding-content-exit")) swap();
    }, 350);
  }
}

/**
 * Update the step indicator text.
 */
export function updateStepIndicator(stepIndicator, current, total) {
  if (!stepIndicator) return;
  stepIndicator.textContent = `${current + 1} of ${total}`;
}

// ---------------------------------------------------------------------------
// DOM element factories
// ---------------------------------------------------------------------------

/**
 * Create a paragraph/block of conversational text.
 * Accepts a string (plain text) or an element.
 */
export function createInfoText(content) {
  const p = document.createElement("div");
  p.className = "cos-onboarding-text";
  if (typeof content === "string") {
    p.innerHTML = content;
  } else if (content instanceof Node) {
    p.appendChild(content);
  }
  return p;
}

/**
 * Create a labelled input field.
 * Returns { wrapper, input } so the caller can read the value.
 */
export function createInputField({ label, placeholder = "", value = "", type = "text" } = {}) {
  const wrapper = document.createElement("div");
  wrapper.className = "cos-onboarding-field";

  if (label) {
    const lbl = document.createElement("label");
    lbl.className = "cos-onboarding-label";
    lbl.textContent = label;
    wrapper.appendChild(lbl);
  }

  const input = document.createElement("input");
  input.className = "cos-onboarding-input";
  input.type = type;
  input.placeholder = placeholder;
  input.value = value;
  wrapper.appendChild(input);

  return { wrapper, input };
}

/**
 * Create a row of buttons.
 * Each button: { label, primary?, onClick }.
 */
export function createButtonGroup(buttons) {
  const row = document.createElement("div");
  row.className = "cos-onboarding-buttons";
  for (const btn of buttons) {
    const el = document.createElement("button");
    el.className = btn.primary
      ? "cos-onboarding-btn cos-onboarding-btn--primary"
      : "cos-onboarding-btn cos-onboarding-btn--secondary";
    el.textContent = btn.label;
    if (typeof btn.onClick === "function") {
      el.addEventListener("click", btn.onClick);
    }
    row.appendChild(el);
  }
  return row;
}

/**
 * Show an inline validation error inside a container.
 */
export function showInlineError(container, message) {
  clearInlineError(container);
  const el = document.createElement("div");
  el.className = "cos-onboarding-error";
  el.textContent = message;
  container.appendChild(el);
}

/**
 * Remove any inline validation error from a container.
 */
export function clearInlineError(container) {
  const existing = container?.querySelector(".cos-onboarding-error");
  if (existing) existing.remove();
}

/**
 * Create a bulleted list from an array of strings (supports HTML).
 */
export function createBulletList(items) {
  const ul = document.createElement("ul");
  ul.className = "cos-onboarding-list";
  for (const item of items) {
    const li = document.createElement("li");
    li.innerHTML = item;
    ul.appendChild(li);
  }
  return ul;
}

/**
 * Create a summary checklist item for the finish step.
 */
export function createSummaryItem(label, status) {
  const row = document.createElement("div");
  row.className = "cos-onboarding-summary-item";
  const check = status ? "\u2713" : "\u2013";
  const checkSpan = document.createElement("span");
  checkSpan.className = status ? "cos-onboarding-summary-check" : "cos-onboarding-summary-pending";
  checkSpan.textContent = check;
  const text = document.createElement("span");
  text.textContent = ` ${label}`;
  row.appendChild(checkSpan);
  row.appendChild(text);
  return row;
}
