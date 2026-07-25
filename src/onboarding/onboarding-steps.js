/**
 * Onboarding step definitions — React 18 function components.
 *
 * Each step: { id, skipIf?(ctx), Component }
 *   • `Component` is a React function component receiving props { ctx } and is
 *     rendered by the controller inside the onboarding card's content area.
 *   • `skipIf(ctx)` must stay pure and DOM-free-safe: the controller calls it
 *     during navigation bookkeeping and tests call it under plain node, so every
 *     window/document read must be guarded (see `pageExists` / the hotkey step).
 *
 * ctx is provided by the controller:
 *   { extensionAPI, deps, advanceStep, goBack, skipToEnd, sessionState }
 *
 * deps contains functions injected from index.js to avoid circular imports.
 *
 * Hard rules (shared with onboarding-ui.js):
 *   • React and Blueprint come from Roam at runtime (`window.React`,
 *     `window.Blueprint.Core`) — never `import` them.
 *   • Nothing in this module may touch window/document at module top level.
 *   • No JSX: elements are built with the `h()` helper from ./onboarding-ui.js.
 *   • Primary action buttons must carry data-cos-primary="true" (the `Buttons`
 *     helper does this for `{ primary: true }`) — the controller's Enter-key
 *     handler clicks the first `[data-cos-primary]` inside the card.
 */

import {
  h,
  frag,
  InfoText,
  Hint,
  BulletList,
  Field,
  Select,
  Buttons,
  OptionCards,
  Summary,
  SummaryItem,
  useInlineError,
  useAutoFocus,
} from "./onboarding-ui.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function detectProvider(key) {
  if (!key) return null;
  if (key.startsWith("sk-ant-")) return "anthropic";
  if (key.startsWith("sk-")) return "openai";
  if (key.startsWith("AIza")) return "gemini";
  if (key.startsWith("gsk_")) return "groq";
  return null;
}

/** Check if a Roam page exists by title. */
function pageExists(title) {
  try {
    const result = window.roamAlphaAPI?.data?.pull?.(
      "[:node/title]",
      `[:node/title "${title}"]`
    );
    return !!(result?.[":node/title"]);
  } catch { return false; }
}

function openCommandPalette() {
  const platform = window.roamAlphaAPI?.platform || {};
  const useMeta = !platform.isPC;
  const event = new KeyboardEvent("keydown", {
    key: "p",
    code: "KeyP",
    keyCode: 80,
    which: 80,
    ctrlKey: !useMeta,
    metaKey: useMeta,
    bubbles: true,
    cancelable: true,
  });
  (document.activeElement || document).dispatchEvent(event);
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

const ONBOARDING_STEPS = [

  // ---- Step 0: Welcome ----
  {
    id: "welcome",
    skipIf: null,
    Component: function WelcomeStep({ ctx }) {
      const { extensionAPI, deps, advanceStep, skipToEnd } = ctx;

      return h(
        "div",
        null,
        h(InfoText, {
          html: "Welcome. I\u2019m your Chief of Staff \u2014 an AI assistant that lives inside your Roam graph.",
        }),
        h(InfoText, {
          html: "I\u2019d like to take a minute to get set up so I can start helping you. We can do this now, or you can configure everything manually in Roam Depot settings any time.",
        }),
        h(Buttons, {
          buttons: [
            {
              label: "Let\u2019s go",
              primary: true,
              onClick: () => advanceStep(),
            },
            {
              label: "I\u2019ll set up manually",
              onClick: () => {
                extensionAPI.settings.set(deps.SETTINGS_KEYS.onboardingComplete, true);
                deps.iziToast.info({
                  class: "cos-toast",
                  title: "No worries",
                  message: "Open Settings \u2192 Chief of Staff whenever you\u2019re ready.",
                  timeout: 5000,
                  position: "bottomRight",
                });
                skipToEnd();
              },
            },
          ],
        })
      );
    },
  },

  // ---- Step 1: Introductions ----
  {
    id: "introductions",
    skipIf(ctx) {
      return !!ctx.extensionAPI?.settings?.get?.(ctx.deps?.SETTINGS_KEYS?.userName);
    },
    Component: function IntroductionsStep({ ctx }) {
      const { useRef } = window.React;
      const { extensionAPI, deps, advanceStep } = ctx;
      const { setError, clearError, errorNode } = useInlineError();

      // Uncontrolled inputs, read on submit \u2014 same as the vanilla fields.
      const nameRef = useRef(null);
      const cosNameRef = useRef(null);

      const onContinue = () => {
        const userName = (nameRef.current ? nameRef.current.value : "").trim();
        if (!userName) {
          setError("I do need something to call you.");
          return;
        }
        clearError();
        extensionAPI.settings.set(deps.SETTINGS_KEYS.userName, userName);
        const cosName =
          (cosNameRef.current ? cosNameRef.current.value : "").trim() || "Chief of Staff";
        extensionAPI.settings.set(deps.SETTINGS_KEYS.assistantName, cosName);
        deps.iziToast.success({
          class: "cos-toast",
          title: "Hello",
          message: `Nice to meet you, ${deps.escapeHtml(userName)}. I\u2019m ${deps.escapeHtml(cosName)}.`,
          timeout: 4000,
          position: "bottomRight",
        });
        advanceStep();
      };

      return h(
        "div",
        null,
        h(InfoText, { html: "Let\u2019s start with introductions." }),
        h(Field, {
          label: "What should I call you?",
          placeholder: "Your name",
          value: deps.getSettingString(extensionAPI, deps.SETTINGS_KEYS.userName, ""),
          inputRef: nameRef,
        }),
        h(InfoText, {
          html: "<strong>What would you like to call me?</strong><br>I\u2019ll answer to \u201cChief of Staff\u201d and any name you choose. You can change this later in settings.",
        }),
        h(Field, {
          placeholder: "Chief of Staff",
          value: deps.getAssistantDisplayName(extensionAPI),
          inputRef: cosNameRef,
        }),
        errorNode,
        h(Buttons, {
          buttons: [
            {
              label: "Continue \u2192",
              primary: true,
              onClick: onContinue,
            },
          ],
        })
      );
    },
  },

  // ---- Step 2: Connect an AI model ----
  {
    id: "api-key",
    skipIf(ctx) {
      // Any configured path counts: built-in/legacy key, ChatGPT
      // subscription, or a custom slot.
      return !!ctx.deps.hasAnyLlmConfigured?.(ctx.extensionAPI);
    },
    Component: function ApiKeyStep({ ctx }) {
      const { useState, useRef, useEffect } = window.React;
      const { extensionAPI, deps, advanceStep } = ctx;
      const { setError, clearError, errorNode } = useInlineError();

      // Sub-view switcher within the single step (same pattern as the composio
      // step): chooser \u2192 apikey | codex | custom.
      const [view, setView] = useState("chooser");

      // --- api-key view state -------------------------------------------------
      const [apiKey, setApiKey] = useState("");
      const [provider, setProvider] = useState("mistral");
      // Debounced prefix detection, mirroring the vanilla input handler:
      // {val, detected} recomputed 150ms after the last keystroke.
      const [probe, setProbe] = useState({ val: "", detected: null });

      // --- codex view state ---------------------------------------------------
      const [waiting, setWaiting] = useState(false);
      // Monotonic token: each connect attempt captures its own value, and any
      // cancel/sub-view swap bumps it, so a cancelled attempt's late-resolving
      // promise can never be mistaken for the current attempt.
      const connectAttempt = useRef(0);

      // --- custom-provider view refs ------------------------------------------
      const nameRef = useRef(null);
      const urlRef = useRef(null);
      const apiKeyFieldRef = useRef(null);
      const modelRef = useRef(null);

      // Unmount guard for the pending connectCodex() promise.
      const alive = useRef(true);
      useEffect(() => () => { alive.current = false; }, []);

      // The controller's auto-focus only fires on step render, so focus the
      // first input ourselves after a sub-view swap.
      useAutoFocus([view], 50);

      useEffect(() => {
        const id = setTimeout(() => {
          const val = apiKey.trim();
          setProbe({ val, detected: detectProvider(val) });
        }, 150);
        return () => clearTimeout(id);
      }, [apiKey]);

      /** Swap sub-view, resetting per-view state the way a rebuild did. */
      const showView = (name) => {
        connectAttempt.current++;
        setWaiting(false);
        clearError();
        setApiKey("");
        setProvider("mistral");
        setProbe({ val: "", detected: null });
        setView(name);
      };

      // ---- chooser ----------------------------------------------------------
      if (view === "chooser") {
        return h(
          "div",
          null,
          h(InfoText, {
            html: "In order for me to think and work, I need access to an AI model. There are three ways to connect one \u2014 pick whichever suits you:",
          }),
          h(OptionCards, {
            options: [
              {
                title: "API key",
                description:
                  "Anthropic Claude, OpenAI GPT, Google Gemini, Mistral, or Groq \u2014 pay-as-you-go, most capable.",
                onClick: () => showView("apikey"),
              },
              {
                title: "ChatGPT subscription",
                description:
                  "Use your ChatGPT Plus/Pro plan with a one-time sign-in code \u2014 no API key. (Experimental)",
                onClick: () => showView("codex"),
              },
              {
                title: "Local or custom provider",
                description:
                  "LM Studio, Ollama, OpenRouter, vLLM \u2014 any OpenAI-compatible endpoint.",
                onClick: () => showView("custom"),
              },
            ],
          })
        );
      }

      // ---- api key ----------------------------------------------------------
      if (view === "apikey") {
        const providerLabelsMap = {
          anthropic: "Anthropic (Claude)",
          openai: "OpenAI (GPT)",
          gemini: "Google (Gemini)",
          groq: "Groq (Llama)",
        };

        // Manual selector only for keys that can't be auto-detected.
        const showManualSelect = !probe.detected && !!probe.val;

        let feedback = null;
        if (probe.detected) {
          feedback = h(
            "span",
            { style: { color: "var(--cos-accent, #4a9eff)" } },
            "\u2713 Detected: ",
            h("strong", null, providerLabelsMap[probe.detected])
          );
        } else if (probe.val) {
          feedback = h(
            "span",
            { style: { color: "var(--cos-text-muted, #888)" } },
            "Select your provider below"
          );
        }

        const onSaveKey = () => {
          const key = apiKey.trim();
          if (!key) {
            setError("Please paste an API key.");
            return;
          }
          const chosen = detectProvider(key) || provider;
          if (!chosen) {
            setError("Please select a provider for this key.");
            return;
          }
          clearError();
          // Write to provider-specific key field
          const keySettingMap = {
            openai: deps.SETTINGS_KEYS.openaiApiKey,
            anthropic: deps.SETTINGS_KEYS.anthropicApiKey,
            gemini: deps.SETTINGS_KEYS.geminiApiKey,
            mistral: deps.SETTINGS_KEYS.mistralApiKey,
            groq: deps.SETTINGS_KEYS.groqApiKey,
          };
          extensionAPI.settings.set(keySettingMap[chosen], key);
          extensionAPI.settings.set(deps.SETTINGS_KEYS.llmProvider, chosen);
          const providerLabels = {
            anthropic: "Anthropic",
            openai: "OpenAI",
            gemini: "Gemini",
            mistral: "Mistral",
            groq: "Groq",
          };
          deps.iziToast.success({
            class: "cos-toast",
            title: `${providerLabels[chosen]} key saved`,
            message: "I\u2019m ready to think.",
            timeout: 4000,
            position: "bottomRight",
          });
          advanceStep();
        };

        return h(
          "div",
          null,
          h(InfoText, {
            html: "I support Anthropic Claude, OpenAI GPT, Google Gemini, Mistral, and Groq \u2014 paste a key from any of them and I\u2019ll recognise which provider it belongs to. For Mistral keys (which have no distinctive prefix), choose your provider from the dropdown.",
          }),
          h(Field, {
            placeholder: "sk-... / AIza... / gsk_...",
            type: "password",
            value: apiKey,
            onChange: (e) => setApiKey(e.target.value),
          }),
          showManualSelect
            ? h(Select, {
                label: "Provider:",
                // Labels are capitalised exactly as the vanilla step did
                // (charAt(0).toUpperCase() + slice(1)), so the option text is
                // unchanged - including "Openai".
                options: ["mistral", "anthropic", "openai", "gemini", "groq"].map((opt) => ({
                  value: opt,
                  label: opt.charAt(0).toUpperCase() + opt.slice(1),
                })),
                value: provider,
                onChange: (e) => setProvider(e.currentTarget.value),
              })
            : null,
          h(
            "div",
            {
              className: "cos-onboarding-detected-provider",
              style: { fontSize: "13px", margin: "4px 0 8px", minHeight: "20px" },
            },
            feedback
          ),
          h(Hint, {
            html: "<small>Your key is stored locally in Roam and is only sent directly to your AI provider. It never passes through any other server.</small>",
          }),
          errorNode,
          h(Buttons, {
            buttons: [
              { label: "Save key \u2192", primary: true, onClick: onSaveKey },
              { label: "\u2190 All options", onClick: () => showView("chooser") },
            ],
          })
        );
      }

      // ---- ChatGPT subscription (Codex) --------------------------------------
      if (view === "codex") {
        const onConnect = async () => {
          if (waiting) return;
          const myAttempt = ++connectAttempt.current;
          setWaiting(true);
          clearError();
          const result = await deps.connectCodex();
          // Stale-guard: the user may have cancelled, left this sub-view, or
          // navigated steps while the flow was pending — any of those bumps
          // the attempt token past ours.
          if (connectAttempt.current !== myAttempt || !alive.current) return;
          setWaiting(false);
          if (result?.connected) {
            // llm-provider was already set by the connect flow
            advanceStep();
            return;
          }
          setError(
            String(
              result?.error?.message ||
                result?.error ||
                "Connection didn\u2019t complete \u2014 try again."
            )
          );
        };

        const onSecondary = () => {
          if (waiting) {
            // Cancel a pending connect: stop polling + hide the code toast.
            // The pending connectCodex promise never settles after this, which
            // is why the connect handler guards on the attempt token instead
            // of relying on the await.
            connectAttempt.current++;
            deps.cancelCodexConnect?.();
            setWaiting(false);
            clearError();
            return;
          }
          showView("chooser");
        };

        return h(
          "div",
          null,
          h(InfoText, {
            html: "Sign in with your ChatGPT Plus/Pro account \u2014 no API key needed. I\u2019ll show you a one-time code; enter it on OpenAI\u2019s sign-in page and we\u2019re connected. <strong>(Experimental)</strong>",
          }),
          h(Hint, {
            html: "<small>Heads-up: these calls route through Roam\u2019s shared proxy, which caps long generations at ~60 seconds. Everyday queries are fine; for heavy skill runs an API key works better.</small>",
          }),
          errorNode,
          h(Buttons, {
            buttons: [
              {
                label: waiting ? "Waiting for sign-in\u2026" : "Connect ChatGPT \u2192",
                primary: true,
                disabled: waiting,
                onClick: onConnect,
              },
              {
                label: waiting ? "Cancel" : "\u2190 All options",
                onClick: onSecondary,
              },
            ],
          })
        );
      }

      // ---- local / custom OpenAI-compatible provider -------------------------
      const readField = (ref) => (ref.current ? ref.current.value : "");

      const onSaveProvider = () => {
        clearError();
        let result;
        try {
          result = deps.saveCustomProviderSlot(extensionAPI, {
            name: readField(nameRef),
            baseUrl: readField(urlRef),
            apiKey: readField(apiKeyFieldRef),
            miniModel: readField(modelRef),
          });
        } catch (err) {
          setError(String(err?.message || err));
          return;
        }
        deps.iziToast.success({
          class: "cos-toast",
          title: `${deps.escapeHtml(result.name)} configured`,
          message:
            "It\u2019s now my primary model. Run \u201cCheck LLM Model Availability\u201d from settings any time to verify it responds.",
          timeout: 5000,
          position: "bottomRight",
        });
        advanceStep();
      };

      return h(
        "div",
        null,
        h(InfoText, {
          html: "Point me at any OpenAI-compatible endpoint \u2014 LM Studio, Ollama, OpenRouter, vLLM, or your own server.",
        }),
        h(Field, {
          label: "Name (optional)",
          placeholder: "LM Studio / Ollama / OpenRouter",
          inputRef: nameRef,
        }),
        h(Field, {
          label: "Base URL",
          placeholder: "http://localhost:1234/v1",
          inputRef: urlRef,
        }),
        h(Field, {
          label: "API key (optional)",
          placeholder: "Leave blank for LM Studio / Ollama",
          type: "password",
          inputRef: apiKeyFieldRef,
        }),
        h(Field, {
          label: "Model",
          placeholder: "e.g. llama-3.1-8b-instruct",
          inputRef: modelRef,
        }),
        h(Hint, {
          html: "<small>Base URL usually ends in /v1 \u2014 LM Studio: http://localhost:1234/v1, Ollama: http://localhost:11434/v1, OpenRouter: https://openrouter.ai/api/v1. Power/failover models and advanced options live in Settings \u2192 Chief of Staff.</small>",
        }),
        errorNode,
        h(Buttons, {
          buttons: [
            { label: "Save provider \u2192", primary: true, onClick: onSaveProvider },
            { label: "\u2190 All options", onClick: () => showView("chooser") },
          ],
        })
      );
    },
  },

  // ---- Step 3: Better Tasks ----
  {
    id: "better-tasks",
    skipIf: null,
    Component: function BetterTasksStep({ ctx }) {
      const { deps, advanceStep, sessionState } = ctx;

      return h(
        "div",
        null,
        h(InfoText, {
          html: "Do you use the <strong>Better Tasks</strong> extension? I have deep integration with it \u2014 I can search, create, and manage tasks with full attribute support (projects, due dates, priorities, and more).",
        }),
        h(InfoText, {
          html: "I work effectively without it too, using Roam\u2019s standard TODO/DONE blocks.",
        }),
        h(Buttons, {
          buttons: [
            {
              label: "Yes, I use Better Tasks",
              primary: true,
              onClick: () => {
                // Read back by memory-pages (Projects bullet) and finish (summary).
                sessionState.betterTasksEnabled = true;
                deps.iziToast.success({
                  class: "cos-toast",
                  title: "Better Tasks",
                  message: "Excellent. I\u2019ll use Better Tasks for all task operations.",
                  timeout: 4000,
                  position: "bottomRight",
                });
                advanceStep();
              },
            },
            {
              label: "No, just standard TODOs",
              onClick: () => {
                sessionState.betterTasksEnabled = false;
                deps.iziToast.info({
                  class: "cos-toast",
                  title: "Standard TODOs",
                  message: "No problem. I\u2019ll work with standard TODO/DONE blocks. If you install Better Tasks later, I\u2019ll detect it automatically.",
                  timeout: 5000,
                  position: "bottomRight",
                });
                advanceStep();
              },
            },
          ],
        })
      );
    },
  },

  // ---- Step 4: Memory Pages ----
  {
    id: "memory-pages",
    skipIf: null,
    Component: function MemoryPagesStep({ ctx }) {
      const { useState, useRef, useEffect } = window.React;
      const { deps, advanceStep, sessionState } = ctx;

      // Unmount guard for the pending runBootstrapMemoryPages() promise: the
      // user can close the card or navigate while it is still in flight, and a
      // dead step must never advance or set state.
      const alive = useRef(true);
      useEffect(() => () => { alive.current = false; }, []);

      // Vanilla had no busy state (the button stayed live during the await, so
      // a double-click bootstrapped twice). React gives us the guard for free.
      const [busy, setBusy] = useState(false);

      const pages = [
        "<strong>[[Chief of Staff/Memory]]</strong> \u2014 context about you and your preferences",
        "<strong>[[Chief of Staff/Inbox]]</strong> \u2014 ideas and items to process later",
        "<strong>[[Chief of Staff/Decisions]]</strong> \u2014 decisions worth tracking",
        "<strong>[[Chief of Staff/Lessons Learned]]</strong> \u2014 patterns and insights over time",
        "<strong>[[Chief of Staff/Improvement Requests]]</strong> \u2014 capability gaps and issues I discover while working",
      ];

      // Only show Projects page if user doesn't use Better Tasks
      const usesBT = sessionState.betterTasksEnabled || deps.hasBetterTasksAPI();
      if (!usesBT) {
        pages.push(
          "<strong>[[Chief of Staff/Projects]]</strong> \u2014 your active projects"
        );
      }

      const onCreate = async () => {
        if (busy) return;
        setBusy(true);
        try {
          await deps.runBootstrapMemoryPages({ silent: true });
        } catch (e) {
          // Surfaced unconditionally, as in the vanilla step \u2014 the user should
          // learn the bootstrap failed even if they navigated away.
          const errMsg = deps.escapeHtml(e?.message || "Unknown error");
          deps.iziToast.error({
            class: "cos-toast",
            title: "Memory pages failed",
            message: `${errMsg}. You can try again later via the command palette: <strong>Chief of Staff: Bootstrap Memory Pages</strong>.`,
            timeout: 8000,
            position: "bottomRight",
          });
        }
        if (!alive.current) return;
        setBusy(false);
        // Vanilla advanced on both success and failure. Preserved.
        advanceStep();
      };

      return h(
        "div",
        null,
        h(InfoText, {
          html: "I\u2019d like to create a few pages in your graph for our shared working memory. These are my notebooks \u2014 you can read, edit, or delete them at any time.",
        }),
        h(InfoText, { html: "I\u2019ll create:" }),
        h(BulletList, { items: pages }),
        h(InfoText, { html: "May I create these now?" }),
        h(Buttons, {
          buttons: [
            {
              label: "Yes, create them",
              primary: true,
              loading: busy,
              disabled: busy,
              onClick: onCreate,
            },
            {
              label: "Not yet",
              disabled: busy,
              onClick: () => {
                deps.iziToast.info({
                  class: "cos-toast",
                  title: "No worries",
                  message: "You can create them later via the command palette: Chief of Staff: Bootstrap Memory Pages.",
                  timeout: 5000,
                  position: "bottomRight",
                });
                advanceStep();
              },
            },
          ],
        })
      );
    },
  },

  // ---- Step 5: Memory Questionnaire ----
  {
    id: "memory-questionnaire",
    skipIf() {
      // Skip if memory page doesn't exist (user declined creation in step 4)
      return !pageExists("Chief of Staff/Memory");
    },
    Component: function MemoryQuestionnaireStep({ ctx }) {
      const { advanceStep, deps } = ctx;

      return h(
        "div",
        null,
        h(InfoText, {
          html: "The more I know about you, the better I can help. I\u2019ve added a series of questions to <strong>[[Chief of Staff/Memory]]</strong> \u2014 things like your role, working style, and current priorities. Your answers become part of my context on every request.",
        }),
        h(InfoText, {
          html: "We can fill this in together now, or you can do it any time.",
        }),
        h(Buttons, {
          buttons: [
            {
              label: "Open Memory page now",
              primary: true,
              onClick: () => {
                try {
                  window.roamAlphaAPI.ui.mainWindow.openPage({
                    page: { title: "Chief of Staff/Memory" },
                  });
                } catch { /* ignore if API unavailable */ }
                deps.iziToast.info({
                  class: "cos-toast",
                  title: "Memory page opened",
                  message: "Fill in what you can \u2014 even a few answers help.",
                  timeout: 4000,
                  position: "bottomRight",
                });
                advanceStep();
              },
            },
            {
              label: "I\u2019ll do it later",
              onClick: () => {
                deps.iziToast.info({
                  class: "cos-toast",
                  title: "Memory",
                  message: "No rush. You can open [[Chief of Staff/Memory]] any time to fill in your context \u2014 even a few answers make a difference.",
                  timeout: 5000,
                  position: "bottomRight",
                });
                advanceStep();
              },
            },
          ],
        })
      );
    },
  },

  // ---- Step 6: Command Palette & Hotkey ----
  {
    id: "hotkey",
    skipIf() {
      // window is absent under node (tests) - the catch keeps skipIf callable.
      try {
        const platform = window.roamAlphaAPI?.platform || {};
        return !!(platform.isMobile || platform.isMobileApp);
      } catch { return false; }
    },
    Component: function HotkeyStep({ ctx }) {
      const { useEffect, useRef } = window.React;
      const { advanceStep, deps, sessionState } = ctx;

      // Timers started from the click handler: tracked so an unmount (Skip,
      // Back, close, teardown) can never fire them against a dead step.
      const aliveRef = useRef(true);
      const timersRef = useRef([]);
      const hotkeyTimerRef = useRef(null);

      useEffect(() => {
        aliveRef.current = true;
        return () => {
          aliveRef.current = false;
          timersRef.current.forEach((id) => clearTimeout(id));
          timersRef.current = [];
          // Only drop the controller-owned handle if it is still ours.
          if (hotkeyTimerRef.current && sessionState._hotkeyTimerId === hotkeyTimerRef.current) {
            delete sessionState._hotkeyTimerId;
          }
          hotkeyTimerRef.current = null;
        };
      }, []);

      const onSetUpHotkey = () => {
        openCommandPalette();
        // Validate command palette opened before showing guidance
        const paletteTimerId = setTimeout(() => {
          const paletteOpen = !!document.querySelector(".rm-command-palette, .bp3-omnibar");
          if (paletteOpen) {
            deps.iziToast.info({
              class: "cos-toast",
              title: "Hotkey setup",
              message: "Search for <strong>Edit Hotkey: Chief of Staff: Ask</strong> and choose your preferred shortcut.",
              timeout: 8000,
              position: "bottomRight",
            });
          } else {
            deps.iziToast.info({
              class: "cos-toast",
              title: "Hotkey setup",
              message: "Open the command palette (<strong>Cmd+P</strong> or <strong>Ctrl+P</strong>), then search for <strong>Edit Hotkey: Chief of Staff: Ask</strong>.",
              timeout: 8000,
              position: "bottomRight",
            });
          }
        }, 300);
        timersRef.current.push(paletteTimerId);

        // 10s auto-advance. The id also lives on sessionState so
        // teardownOnboarding() can cancel it (reserved controller key).
        const advanceTimerId = setTimeout(() => {
          if (sessionState._hotkeyTimerId === advanceTimerId) delete sessionState._hotkeyTimerId;
          hotkeyTimerRef.current = null;
          if (!aliveRef.current) return;
          advanceStep();
        }, 10000);
        timersRef.current.push(advanceTimerId);
        hotkeyTimerRef.current = advanceTimerId;
        sessionState._hotkeyTimerId = advanceTimerId;
      };

      return h(
        "div",
        null,
        h(InfoText, { html: "You can ask me things via the command palette:" }),
        h(InfoText, { html: "<strong>Chief of Staff: Ask</strong>" }),
        h(InfoText, {
          html: "I\u2019d recommend setting a keyboard shortcut for this \u2014 it makes reaching me much faster.",
        }),
        h(Buttons, {
          buttons: [
            {
              label: "Set up hotkey now",
              primary: true,
              onClick: onSetUpHotkey,
            },
            {
              label: "Skip",
              onClick: () => advanceStep(),
            },
          ],
        })
      );
    },
  },

  // ---- Step 7: Chat Panel ----
  {
    id: "chat-panel",
    skipIf: null,
    Component: function ChatPanelStep({ ctx }) {
      const { extensionAPI, deps, advanceStep } = ctx;

      const onShowChatPanel = () => {
        if (!deps.chatPanelIsOpen()) deps.toggleChatPanel();
        deps.iziToast.success({
          class: "cos-toast",
          title: "Chat panel",
          message: "There I am. Try typing something!",
          timeout: 4000,
          position: "bottomRight",
        });
        // Write initial message to chat
        const userName = deps.getSettingString(extensionAPI, deps.SETTINGS_KEYS.userName, "");
        const greeting = userName
          ? `Hello, ${userName}. I\u2019m set up and ready to help. Try asking me something \u2014 here are a few ideas:\n\n\u2022 **What was I working on last week?**\n\u2022 **Run my daily briefing**\n\u2022 **Search my graph for [topic]**\n\nType \`/power\` before a message to use a more capable model. I\u2019d also recommend setting a hotkey for **Chief of Staff: Toggle Chat Panel** via the command palette.`
          : "Hello! I\u2019m set up and ready to help. Try asking me something \u2014 here are a few ideas:\n\n\u2022 **What was I working on last week?**\n\u2022 **Run my daily briefing**\n\u2022 **Search my graph for [topic]**\n\nType `/power` before a message to use a more capable model.";
        // Deliberately NOT cancelled on unmount: advanceStep() below unmounts
        // this step immediately, so a cleanup would kill the greeting. It only
        // touches the chat panel (never onboarding DOM) and never navigates.
        setTimeout(() => {
          deps.appendChatPanelMessage("assistant", greeting);
          deps.appendChatPanelHistory("assistant", greeting);
          // Focus the chat input so user can type immediately
          const chatInput = document.querySelector(".cos-chat-input");
          if (chatInput) chatInput.focus();
        }, 500);
        advanceStep();
      };

      return h(
        "div",
        null,
        h(InfoText, {
          html: "We can also talk via a floating chat panel \u2014 it\u2019s like having me on call in the corner of your screen. Persistent history, drag it where you like, pin responses to your daily page.",
        }),
        h(Buttons, {
          buttons: [
            {
              label: "Show me the chat panel",
              primary: true,
              onClick: onShowChatPanel,
            },
            {
              label: "Not now",
              onClick: () => advanceStep(),
            },
          ],
        })
      );
    },
  },

  // ---- Step 8: Skills ----
  {
    id: "skills",
    skipIf: null,
    Component: function SkillsStep({ ctx }) {
      const { useEffect, useRef } = window.React;
      const { extensionAPI, deps, advanceStep, sessionState } = ctx;

      const aliveRef = useRef(true);
      const timersRef = useRef([]);

      useEffect(() => {
        aliveRef.current = true;
        return () => {
          aliveRef.current = false;
          timersRef.current.forEach((id) => clearTimeout(id));
          timersRef.current = [];
        };
      }, []);

      const onInstallSkills = async () => {
        try {
          await deps.bootstrapSkillsPage({ silent: true });
          deps.registerMemoryPullWatches();
          try {
            window.roamAlphaAPI.ui.mainWindow.openPage({
              page: { title: "Chief of Staff/Skills" },
            });
          } catch { /* ignore */ }

          // Contextual toast based on user's setup choices
          const hasBT = sessionState.betterTasksEnabled || deps.hasBetterTasksAPI();
          const composioUrl = deps.getSettingString(extensionAPI, deps.SETTINGS_KEYS.composioMcpUrl, "");
          const hasComposio = !!composioUrl && composioUrl !== "enter your composio mcp url here";

          let toastMsg;
          if (hasBT && hasComposio) {
            toastMsg = "6 skills installed \u2713 \u2014 you\u2019re fully loaded. Every skill will work at full capability.";
          } else if (hasBT) {
            toastMsg = "6 skills installed \u2713 \u2014 most work beautifully with your graph and Better Tasks. Skills like Daily Briefing and Weekly Review will be even more powerful once you connect external tools.";
          } else if (hasComposio) {
            toastMsg = "6 skills installed \u2713 \u2014 all will work using your connected tools and Roam\u2019s built-in TODO system. Install Better Tasks any time for richer task management.";
          } else {
            toastMsg = "6 skills installed \u2713 \u2014 several work right away (Brain Dump, Resume Context, Suggest Workflows, and more). Others will unlock their full potential as you add Better Tasks or connect external tools.";
          }

          deps.iziToast.success({
            class: "cos-toast",
            title: "Skills installed",
            message: toastMsg,
            timeout: 6000,
            position: "bottomRight",
          });
        } catch (e) {
          const errMsg = deps.escapeHtml(e?.message || "Unknown error");
          deps.iziToast.error({
            class: "cos-toast",
            title: "Skills install failed",
            message: `${errMsg}. You can try again later via the command palette: <strong>Chief of Staff: Bootstrap Skills Page</strong>.`,
            timeout: 8000,
            position: "bottomRight",
          });
        }
        // Brief delay to let Roam settle after creating many blocks.
        // Guarded: if the user navigated away during the await, don't advance
        // a step that is no longer on screen.
        if (!aliveRef.current) return;
        const settleTimerId = setTimeout(() => {
          if (!aliveRef.current) return;
          advanceStep();
        }, 500);
        timersRef.current.push(settleTimerId);
      };

      return h(
        "div",
        null,
        h(InfoText, {
          html: "One of my best features is <strong>Skills</strong> \u2014 structured workflows I can execute end-to-end. Things like Daily Briefings, Weekly Reviews, Brain Dumps, Meeting Processing, and more.",
        }),
        h(InfoText, {
          html: "I have a full set of built-in skills ready to install. They\u2019re templates \u2014 you can customise, rewrite, or delete any of them.",
        }),
        h(Buttons, {
          buttons: [
            {
              label: "Install skills",
              primary: true,
              onClick: onInstallSkills,
            },
            {
              label: "Skip for now",
              onClick: () => {
                deps.iziToast.info({
                  class: "cos-toast",
                  title: "Skills",
                  message: "You can install them any time via the command palette: Chief of Staff: Bootstrap Skills Page.",
                  timeout: 5000,
                  position: "bottomRight",
                });
                advanceStep();
              },
            },
          ],
        })
      );
    },
  },

  // ---- Step 9: External Tools (Composio) ----
  {
    id: "composio",
    skipIf: null,
    Component: function ComposioStep({ ctx }) {
      const { useState } = window.React;
      const { advanceStep } = ctx;

      // "Tell me more" swaps the button row for the detailed instructions.
      const [expanded, setExpanded] = useState(false);
      useAutoFocus([expanded], 50);

      return h(
        "div",
        null,
        h(InfoText, {
          html: "There are many ways we can work together, and one is to give me access to external tools. With those, I can check your email, read your calendar to create a day plan, manage tasks in Todoist, and much more.",
        }),
        h(InfoText, {
          html: "I\u2019m fully capable within Roam on my own. With external tools, I gain superpowers.",
        }),
        h(InfoText, {
          html: "The provider we use is <strong>Composio</strong> \u2014 it handles secure authentication to external services. Setting it up requires a few extra steps outside of Roam.",
        }),
        expanded
          ? h(
              "div",
              null,
              h(InfoText, { html: "To connect external tools:" }),
              h(BulletList, {
                items: [
                  "Sign up at <a href=\"https://composio.dev\" target=\"_blank\" rel=\"noopener\">composio.dev</a>",
                  "Deploy the included CORS proxy (see the README for instructions)",
                  "Add your Composio MCP URL and API key in Settings \u2192 Chief of Staff",
                  "Run <strong>Chief of Staff: Connect Composio</strong> from the command palette",
                  "Install tools by saying \u201cinstall google calendar\u201d in our chat",
                ],
              }),
              h(InfoText, { html: "Full instructions are in the README." }),
              h(Buttons, {
                buttons: [
                  {
                    label: "Open README",
                    primary: true,
                    onClick: () => {
                      try {
                        window.open("https://github.com/mlava/chief-of-staff#2-connect-composio-optional", "_blank", "noopener");
                      } catch { /* ignore */ }
                      advanceStep();
                    },
                  },
                  {
                    label: "Done",
                    onClick: () => advanceStep(),
                  },
                ],
              })
            )
          : h(
              "div",
              null,
              h(Buttons, {
                buttons: [
                  {
                    label: "Tell me more",
                    primary: true,
                    onClick: () => setExpanded(true),
                  },
                  {
                    label: "Maybe later",
                    onClick: () => advanceStep(),
                  },
                ],
              })
            )
      );
    },
  },

  // ---- Step 10: Local MCP Servers ----
  {
    id: "local-mcp",
    skipIf: null,
    Component: function LocalMcpStep({ ctx }) {
      const { useState, useRef, useEffect } = window.React;
      const { extensionAPI, deps, advanceStep } = ctx;
      const { setError, clearError, errorNode } = useInlineError();

      const alive = useRef(true);
      useEffect(() => () => { alive.current = false; }, []);
      const busy = useRef(false);

      // Snapshot the connection state once, exactly like the vanilla render()
      // read it once: a failed connect attempt must not re-branch the view.
      const [snapshot] = useState(() => {
        const configuredPorts = deps.getLocalMcpPorts(extensionAPI);
        const clients = deps.getLocalMcpClients();
        const serverNames = [];
        for (const [, entry] of clients) {
          if (entry?.serverName) serverNames.push(deps.escapeHtml(entry.serverName));
        }
        const connectedCount = Array.from(clients.values()).filter((e) => e?.serverName).length;
        return { configuredPorts, connectedCount, serverNames };
      });
      const { configuredPorts, connectedCount, serverNames } = snapshot;

      let body;
      if (connectedCount > 0) {
        body = frag(
          h(InfoText, {
            html: `<span style="color:var(--cos-accent,#4a9eff)">\u2713 Already connected to ${connectedCount} server${connectedCount > 1 ? "s" : ""}: <strong>${serverNames.join(", ")}</strong></span>`,
          }),
          h(Buttons, {
            buttons: [
              {
                label: "Continue \u2192",
                primary: true,
                onClick: () => advanceStep(),
              },
            ],
          })
        );
      } else if (configuredPorts.length > 0) {
        const tryConnect = async () => {
          if (busy.current) return; // one attempt at a time
          busy.current = true;
          clearError();
          let connected = 0;
          for (const port of configuredPorts) {
            try {
              const result = await deps.connectLocalMcp(port);
              if (result) connected++;
            } catch { /* ignore */ }
          }
          busy.current = false;
          if (connected > 0) {
            // The connections really happened, so the toast fires even when the
            // user closed onboarding mid-flight (same reasoning as the finish
            // step's chat message). Only the navigation is guarded.
            deps.iziToast.success({
              class: "cos-toast",
              title: "Local MCP",
              message: `Connected to ${connected} server${connected > 1 ? "s" : ""}.`,
              timeout: 4000,
              position: "bottomRight",
            });
            if (!alive.current) return; // card is gone — don't advance a dead step
            advanceStep();
            return;
          }
          if (!alive.current) return; // unmounted — no state updates
          setError("Could not connect. Check that your servers are running and try again, or continue and connect later.");
        };

        body = frag(
          h(InfoText, {
            html: `You have ports configured (<strong>${configuredPorts.map((p) => deps.escapeHtml(String(p))).join(", ")}</strong>) but no servers are connected yet. Make sure your supergateway is running, then connect.`,
          }),
          h(
            "div",
            null,
            errorNode,
            h(Buttons, {
              buttons: [
                {
                  label: "Try connecting now",
                  primary: true,
                  onClick: tryConnect,
                },
                {
                  label: "Skip",
                  onClick: () => advanceStep(),
                },
              ],
            })
          )
        );
      } else {
        body = frag(
          h(InfoText, {
            html: "To set this up, add your server ports in <strong>Settings \u2192 Chief of Staff \u2192 Local MCP Server Ports</strong> (comma-separated, e.g. <code>8765,8766</code>), then run <strong>Chief of Staff: Connect Local MCP</strong> from the command palette.",
          }),
          h(Hint, {
            html: "<small>Full setup instructions are in the README. This is entirely optional \u2014 I work great without it.</small>",
          }),
          h(Buttons, {
            buttons: [
              {
                label: "Continue \u2192",
                primary: true,
                onClick: () => advanceStep(),
              },
            ],
          })
        );
      }

      return h(
        "div",
        null,
        h(InfoText, {
          html: "I can also connect to <strong>local MCP servers</strong> running on your machine \u2014 tools like Zotero, GitHub, or any custom server that speaks the Model Context Protocol.",
        }),
        h(InfoText, {
          html: "If you run MCP servers via <strong>supergateway</strong> (which bridges stdio servers to SSE), I can connect to them directly in your browser. No proxy needed.",
        }),
        body
      );
    },
  },

  // ---- Step 11: Finish ----
  {
    id: "finish",
    skipIf: null,
    Component: function FinishStep({ ctx }) {
      const { extensionAPI, deps, skipToEnd, sessionState } = ctx;

      const userName = deps.getSettingString(extensionAPI, deps.SETTINGS_KEYS.userName, "");
      const safeName = userName ? ", " + deps.escapeHtml(userName) : "";

      // Build summary — any configured LLM path (key, subscription, custom
      // slot) counts as "AI provider set up"
      const provider = deps.getSettingString(extensionAPI, deps.SETTINGS_KEYS.llmProvider, "");
      const hasAnyKey = !!deps.hasAnyLlmConfigured?.(extensionAPI);
      const providerLabels = { anthropic: "Anthropic", openai: "OpenAI", gemini: "Gemini", mistral: "Mistral", groq: "Groq" };
      let providerLabel = providerLabels[provider] || "Not set";
      // If the saved primary is a custom slot, use the friendly name
      const slotMatch = String(provider || "").match(/^(custom-\d+)\b/i);
      if (slotMatch && deps.getCustomProviderConfig) {
        const cfg = deps.getCustomProviderConfig(extensionAPI, slotMatch[1].toLowerCase());
        if (cfg) providerLabel = cfg.name;
      }
      if (provider === "openai-codex") {
        const codexStatus = deps.getCodexAuthStatus?.(extensionAPI);
        providerLabel = codexStatus?.email
          ? `ChatGPT subscription (${codexStatus.email})`
          : "ChatGPT subscription";
      }

      // Memory pages — check if the main memory page exists
      const memoryCreated = pageExists("Chief of Staff/Memory");
      // Skills
      const skillsCreated = pageExists("Chief of Staff/Skills");
      // Better Tasks — check both runtime API and user's onboarding choice
      const usesBT = sessionState.betterTasksEnabled || deps.hasBetterTasksAPI();
      // External tools
      const composioUrl = deps.getSettingString(extensionAPI, deps.SETTINGS_KEYS.composioMcpUrl, "");
      const composioConfigured = !!composioUrl && composioUrl !== "enter your composio mcp url here";
      // Local MCP
      const localConnected = Array.from(deps.getLocalMcpClients().values()).filter((e) => e?.serverName).length;

      return h(
        "div",
        null,
        h(InfoText, {
          html: `We\u2019re all set${safeName}. Here\u2019s a quick summary of what\u2019s configured:`,
        }),
        h(
          Summary,
          null,
          h(SummaryItem, { key: "provider", label: `AI provider: ${providerLabel}`, status: hasAnyKey }),
          h(SummaryItem, {
            key: "memory",
            label: `Memory pages: ${memoryCreated ? "Created" : "Not yet"}`,
            status: memoryCreated,
          }),
          h(SummaryItem, {
            key: "skills",
            label: `Skills: ${skillsCreated ? "Installed" : "Not yet"}`,
            status: skillsCreated,
          }),
          h(SummaryItem, {
            key: "better-tasks",
            label: `Better Tasks: ${usesBT ? "Enabled" : "Not using"}`,
            status: usesBT,
          }),
          h(SummaryItem, {
            key: "composio",
            label: `External tools: ${composioConfigured ? "Configured" : "Set up later"}`,
            status: composioConfigured,
          }),
          h(SummaryItem, {
            key: "local-mcp",
            label: `Local MCP: ${localConnected > 0 ? localConnected + " server" + (localConnected > 1 ? "s" : "") + " connected" : "Not configured"}`,
            status: localConnected > 0,
          })
        ),
        h(InfoText, {
          html: "You can always revisit settings in <strong>Settings \u2192 Chief of Staff</strong>, or re-run this walkthrough from the command palette.",
        }),
        h(Buttons, {
          buttons: [
            {
              label: "Start working together",
              primary: true,
              onClick: () => {
                extensionAPI.settings.set(deps.SETTINGS_KEYS.onboardingComplete, true);

                // Conditional closing message. The 400ms timer is deliberately
                // NOT cancelled on unmount: skipToEnd() tears the card down
                // immediately and the message lands in the chat panel, which
                // outlives onboarding.
                if (deps.chatPanelIsOpen()) {
                  setTimeout(() => {
                    const msg = "Ready when you are. If you\u2019d like to see what I can do, try: \u201cRun my daily briefing\u201d or \u201cWhat was I working on?\u201d";
                    deps.appendChatPanelMessage("assistant", msg);
                    deps.appendChatPanelHistory("assistant", msg);
                  }, 400);
                } else {
                  deps.iziToast.success({
                    class: "cos-toast",
                    title: "All set",
                    message: "Open the command palette and run Chief of Staff: Ask whenever you need me.",
                    timeout: 5000,
                    position: "bottomRight",
                  });
                }

                skipToEnd();
              },
            },
          ],
        })
      );
    },
  },
];

export { ONBOARDING_STEPS, detectProvider };
