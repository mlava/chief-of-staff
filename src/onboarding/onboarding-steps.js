/**
 * Onboarding step definitions.
 *
 * Each step: { id, render(ctx), skipIf?(ctx) }
 *
 * ctx is provided by the controller:
 *   { extensionAPI, deps, advanceStep, skipToEnd, card, contentArea }
 *
 * deps contains functions injected from index.js to avoid circular imports.
 */

import {
  createInfoText,
  createInputField,
  createButtonGroup,
  createBulletList,
  createSummaryItem,
  showInlineError,
  clearInlineError,
} from "./onboarding-ui.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function detectProvider(key) {
  if (!key) return null;
  if (key.startsWith("sk-ant-")) return "anthropic";
  if (key.startsWith("sk-")) return "openai";
  if (key.startsWith("AIza")) return "gemini";
  return null;
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
    render(ctx) {
      const { extensionAPI, deps, advanceStep, skipToEnd } = ctx;
      const frag = document.createDocumentFragment();

      frag.appendChild(createInfoText(
        "Welcome. I\u2019m your Chief of Staff \u2014 an AI assistant that lives inside your Roam graph."
      ));
      frag.appendChild(createInfoText(
        "I\u2019d like to take a minute to get set up so I can start helping you. We can do this now, or you can configure everything manually in Roam Depot settings any time."
      ));
      frag.appendChild(createButtonGroup([
        {
          label: "Let\u2019s go",
          primary: true,
          onClick: () => advanceStep(),
        },
        {
          label: "I\u2019ll set up manually",
          primary: false,
          onClick: () => {
            extensionAPI.settings.set(deps.SETTINGS_KEYS.onboardingComplete, true);
            deps.iziToast.info({
              title: "No worries",
              message: "Open Settings \u2192 Chief of Staff whenever you\u2019re ready.",
              timeout: 5000,
              position: "bottomRight",
            });
            skipToEnd();
          },
        },
      ]));

      return frag;
    },
  },

  // ---- Step 1: Introductions ----
  {
    id: "introductions",
    skipIf(ctx) {
      return !!ctx.extensionAPI.settings.get(ctx.deps.SETTINGS_KEYS.userName);
    },
    render(ctx) {
      const { extensionAPI, deps, advanceStep } = ctx;
      const frag = document.createDocumentFragment();

      frag.appendChild(createInfoText("Let\u2019s start with introductions."));

      const nameField = createInputField({
        label: "What should I call you?",
        placeholder: "Your name",
        value: deps.getSettingString(extensionAPI, deps.SETTINGS_KEYS.userName, ""),
      });
      frag.appendChild(nameField.wrapper);

      frag.appendChild(createInfoText(
        "<strong>What would you like to call me?</strong><br>I\u2019ll answer to \u201cChief of Staff\u201d and any name you choose. You can change this later in settings."
      ));

      const cosNameField = createInputField({
        placeholder: "Chief of Staff",
        value: deps.getAssistantDisplayName(extensionAPI),
      });
      frag.appendChild(cosNameField.wrapper);

      const btnContainer = document.createElement("div");
      frag.appendChild(btnContainer);
      btnContainer.appendChild(createButtonGroup([
        {
          label: "Continue \u2192",
          primary: true,
          onClick: () => {
            const userName = nameField.input.value.trim();
            if (!userName) {
              showInlineError(btnContainer, "I do need something to call you.");
              return;
            }
            clearInlineError(btnContainer);
            extensionAPI.settings.set(deps.SETTINGS_KEYS.userName, userName);
            const cosName = cosNameField.input.value.trim() || "Chief of Staff";
            extensionAPI.settings.set(deps.SETTINGS_KEYS.assistantName, cosName);
            deps.iziToast.success({
              title: "Hello",
              message: `Nice to meet you, ${userName}. I\u2019m ${cosName}.`,
              timeout: 4000,
              position: "bottomRight",
            });
            advanceStep();
          },
        },
      ]));

      return frag;
    },
  },

  // ---- Step 2: API Key ----
  {
    id: "api-key",
    skipIf(ctx) {
      const { extensionAPI, deps } = ctx;
      return !!(
        deps.getSettingString(extensionAPI, deps.SETTINGS_KEYS.anthropicApiKey, "") ||
        deps.getSettingString(extensionAPI, deps.SETTINGS_KEYS.openaiApiKey, "") ||
        deps.getSettingString(extensionAPI, deps.SETTINGS_KEYS.geminiApiKey, "") ||
        deps.getSettingString(extensionAPI, deps.SETTINGS_KEYS.mistralApiKey, "") ||
        deps.getSettingString(extensionAPI, deps.SETTINGS_KEYS.llmApiKey, "")
      );
    },
    render(ctx) {
      const { extensionAPI, deps, advanceStep } = ctx;
      const frag = document.createDocumentFragment();

      frag.appendChild(createInfoText(
        "In order for me to think and work, I need access to an AI model. I support Anthropic Claude, OpenAI GPT, Google Gemini, and Mistral \u2014 you can use any of them."
      ));
      frag.appendChild(createInfoText(
        "Paste an API key below. I\u2019ll recognise which provider it belongs to and configure everything automatically. For Mistral keys (which have no distinctive prefix), choose your provider from the dropdown."
      ));

      const keyField = createInputField({
        placeholder: "sk-... / AIza...",
        type: "password",
      });
      frag.appendChild(keyField.wrapper);

      // Manual provider selector for keys that can't be auto-detected
      const providerSelectWrapper = document.createElement("div");
      providerSelectWrapper.style.cssText = "margin: 8px 0; display: none;";
      const providerSelectLabel = document.createElement("label");
      providerSelectLabel.textContent = "Provider: ";
      providerSelectLabel.style.cssText = "font-size: 13px; margin-right: 6px;";
      const providerSelect = document.createElement("select");
      providerSelect.style.cssText = "font-size: 13px; padding: 2px 6px;";
      for (const opt of ["mistral", "anthropic", "openai", "gemini"]) {
        const el = document.createElement("option");
        el.value = opt;
        el.textContent = opt.charAt(0).toUpperCase() + opt.slice(1);
        providerSelect.appendChild(el);
      }
      providerSelectWrapper.appendChild(providerSelectLabel);
      providerSelectWrapper.appendChild(providerSelect);
      frag.appendChild(providerSelectWrapper);

      // Show/hide manual selector based on whether we can auto-detect
      keyField.input.addEventListener("input", () => {
        const detected = detectProvider(keyField.input.value.trim());
        providerSelectWrapper.style.display = (!detected && keyField.input.value.trim()) ? "block" : "none";
      });

      frag.appendChild(createInfoText(
        "<small>Your key is stored locally in Roam and is only sent directly to your AI provider. It never passes through any other server.</small>"
      ));

      const btnContainer = document.createElement("div");
      frag.appendChild(btnContainer);
      btnContainer.appendChild(createButtonGroup([
        {
          label: "Save key \u2192",
          primary: true,
          onClick: () => {
            const key = keyField.input.value.trim();
            if (!key) {
              showInlineError(btnContainer, "Please paste an API key.");
              return;
            }
            const provider = detectProvider(key) || providerSelect.value;
            if (!provider) {
              showInlineError(
                btnContainer,
                "Please select a provider for this key."
              );
              return;
            }
            clearInlineError(btnContainer);
            // Write to provider-specific key field
            const keySettingMap = {
              openai: deps.SETTINGS_KEYS.openaiApiKey,
              anthropic: deps.SETTINGS_KEYS.anthropicApiKey,
              gemini: deps.SETTINGS_KEYS.geminiApiKey,
              mistral: deps.SETTINGS_KEYS.mistralApiKey
            };
            extensionAPI.settings.set(keySettingMap[provider], key);
            extensionAPI.settings.set(deps.SETTINGS_KEYS.llmProvider, provider);
            const providerLabels = { anthropic: "Anthropic", openai: "OpenAI", gemini: "Gemini", mistral: "Mistral" };
            deps.iziToast.success({
              title: `${providerLabels[provider]} key saved`,
              message: "I\u2019m ready to think.",
              timeout: 4000,
              position: "bottomRight",
            });
            advanceStep();
          },
        },
      ]));

      return frag;
    },
  },

  // ---- Step 3: Better Tasks ----
  {
    id: "better-tasks",
    skipIf: null,
    render(ctx) {
      const { extensionAPI, deps, advanceStep, sessionState } = ctx;
      const frag = document.createDocumentFragment();

      frag.appendChild(createInfoText(
        "Do you use the <strong>Better Tasks</strong> extension? I have deep integration with it \u2014 I can search, create, and manage tasks with full attribute support (projects, due dates, priorities, and more)."
      ));
      frag.appendChild(createInfoText(
        "I work effectively without it too, using Roam\u2019s standard TODO/DONE blocks."
      ));
      frag.appendChild(createButtonGroup([
        {
          label: "Yes, I use Better Tasks",
          primary: true,
          onClick: () => {
            sessionState.betterTasksEnabled = true;
            extensionAPI.settings.set(deps.SETTINGS_KEYS.betterTasksEnabled, true);
            deps.iziToast.success({
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
          primary: false,
          onClick: () => {
            sessionState.betterTasksEnabled = false;
            extensionAPI.settings.set(deps.SETTINGS_KEYS.betterTasksEnabled, false);
            deps.iziToast.info({
              title: "Standard TODOs",
              message: "No problem. I\u2019ll work with standard TODO/DONE blocks. If you install Better Tasks later, I\u2019ll detect it automatically.",
              timeout: 5000,
              position: "bottomRight",
            });
            advanceStep();
          },
        },
      ]));

      return frag;
    },
  },

  // ---- Step 4: Memory Pages ----
  {
    id: "memory-pages",
    skipIf: null,
    render(ctx) {
      const { extensionAPI, deps, advanceStep, sessionState } = ctx;
      const frag = document.createDocumentFragment();

      frag.appendChild(createInfoText(
        "I\u2019d like to create a few pages in your graph for our shared working memory. These are my notebooks \u2014 you can read, edit, or delete them at any time."
      ));
      frag.appendChild(createInfoText("I\u2019ll create:"));

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

      frag.appendChild(createBulletList(pages));
      frag.appendChild(createInfoText("May I create these now?"));

      frag.appendChild(createButtonGroup([
        {
          label: "Yes, create them",
          primary: true,
          onClick: async () => {
            try {
              await deps.runBootstrapMemoryPages({ silent: true });
            } catch (e) {
              deps.showErrorToast("Bootstrap failed", e?.message || "Unknown error");
            }
            advanceStep();
          },
        },
        {
          label: "Not yet",
          primary: false,
          onClick: () => {
            deps.iziToast.info({
              title: "No worries",
              message: "You can create them later via the command palette: Chief of Staff: Bootstrap Memory Pages.",
              timeout: 5000,
              position: "bottomRight",
            });
            advanceStep();
          },
        },
      ]));

      return frag;
    },
  },

  // ---- Step 5: Memory Questionnaire ----
  {
    id: "memory-questionnaire",
    skipIf() {
      // Skip if memory page doesn't exist (user declined creation in step 4)
      try {
        const result = window.roamAlphaAPI?.data?.pull?.(
          "[:node/title]",
          '[:node/title "Chief of Staff/Memory"]'
        );
        return !result?.[":node/title"];
      } catch { return true; }
    },
    render(ctx) {
      const { advanceStep, deps } = ctx;
      const frag = document.createDocumentFragment();

      frag.appendChild(createInfoText(
        "The more I know about you, the better I can help. I\u2019ve added a series of questions to <strong>[[Chief of Staff/Memory]]</strong> \u2014 things like your role, working style, and current priorities. Your answers become part of my context on every request."
      ));
      frag.appendChild(createInfoText(
        "We can fill this in together now, or you can do it any time."
      ));
      frag.appendChild(createButtonGroup([
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
          primary: false,
          onClick: () => advanceStep(),
        },
      ]));

      return frag;
    },
  },

  // ---- Step 6: Command Palette & Hotkey ----
  {
    id: "hotkey",
    skipIf() {
      const platform = window.roamAlphaAPI?.platform || {};
      return !!(platform.isMobile || platform.isMobileApp);
    },
    render(ctx) {
      const { advanceStep, deps } = ctx;
      const frag = document.createDocumentFragment();

      frag.appendChild(createInfoText(
        "You can ask me things via the command palette:"
      ));
      frag.appendChild(createInfoText(
        "<strong>Chief of Staff: Ask</strong>"
      ));
      frag.appendChild(createInfoText(
        "I\u2019d recommend setting a keyboard shortcut for this \u2014 it makes reaching me much faster."
      ));
      frag.appendChild(createButtonGroup([
        {
          label: "Set up hotkey now",
          primary: true,
          onClick: () => {
            openCommandPalette();
            setTimeout(() => {
              deps.iziToast.info({
                title: "Hotkey setup",
                message: "Search for <strong>Edit Hotkey: Chief of Staff: Ask</strong> and choose your preferred shortcut.",
                timeout: 6000,
                position: "bottomRight",
              });
            }, 300);
            sessionState._hotkeyTimerId = setTimeout(() => {
              delete sessionState._hotkeyTimerId;
              advanceStep();
            }, 8000);
          },
        },
        {
          label: "Skip",
          primary: false,
          onClick: () => advanceStep(),
        },
      ]));

      return frag;
    },
  },

  // ---- Step 7: Chat Panel ----
  {
    id: "chat-panel",
    skipIf: null,
    render(ctx) {
      const { extensionAPI, deps, advanceStep } = ctx;
      const frag = document.createDocumentFragment();

      frag.appendChild(createInfoText(
        "We can also talk via a floating chat panel \u2014 it\u2019s like having me on call in the corner of your screen. Persistent history, drag it where you like, pin responses to your daily page."
      ));
      frag.appendChild(createButtonGroup([
        {
          label: "Show me the chat panel",
          primary: true,
          onClick: () => {
            deps.toggleChatPanel();
            deps.iziToast.success({
              title: "Chat panel",
              message: "There I am. Say hello if you like.",
              timeout: 4000,
              position: "bottomRight",
            });
            // Write initial message to chat
            const userName = deps.getSettingString(extensionAPI, deps.SETTINGS_KEYS.userName, "");
            const greeting = userName
              ? `Hello, ${userName}. I\u2019m set up and ready to help. Try asking me something, or type \`/power\` before a message to use a more capable model.\n\nI\u2019d recommend setting a hotkey for **Chief of Staff: Toggle Chat Panel** too \u2014 same process as before via the command palette.`
              : "Hello! I\u2019m set up and ready to help. Try asking me something, or type `/power` before a message to use a more capable model.";
            setTimeout(() => {
              deps.appendChatPanelMessage("assistant", greeting);
              deps.appendChatPanelHistory("assistant", greeting);
            }, 500);
            advanceStep();
          },
        },
        {
          label: "Not now",
          primary: false,
          onClick: () => advanceStep(),
        },
      ]));

      return frag;
    },
  },

  // ---- Step 8: Skills ----
  {
    id: "skills",
    skipIf: null,
    render(ctx) {
      const { extensionAPI, deps, advanceStep, sessionState } = ctx;
      const frag = document.createDocumentFragment();

      frag.appendChild(createInfoText(
        "One of my best features is <strong>Skills</strong> \u2014 structured workflows I can execute end-to-end. Things like Daily Briefings, Weekly Reviews, Brain Dumps, Meeting Processing, and more."
      ));
      frag.appendChild(createInfoText(
        "I have a full set of built-in skills ready to install. They\u2019re templates \u2014 you can customise, rewrite, or delete any of them."
      ));
      frag.appendChild(createButtonGroup([
        {
          label: "Install skills",
          primary: true,
          onClick: async () => {
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
                toastMsg = "16 skills installed \u2713 \u2014 you\u2019re fully loaded. Every skill will work at full capability.";
              } else if (hasBT) {
                toastMsg = "16 skills installed \u2713 \u2014 most work beautifully with your graph and Better Tasks. Skills like Daily Briefing and Weekly Review will be even more powerful once you connect external tools.";
              } else if (hasComposio) {
                toastMsg = "16 skills installed \u2713 \u2014 all will work using your connected tools and Roam\u2019s built-in TODO system. Install Better Tasks any time for richer task management.";
              } else {
                toastMsg = "16 skills installed \u2713 \u2014 several work right away (Brain Dump, Resume Context, Intention Clarifier, and more). Others will unlock their full potential as you add Better Tasks or connect external tools.";
              }

              deps.iziToast.success({
                title: "Skills installed",
                message: toastMsg,
                timeout: 6000,
                position: "bottomRight",
              });
            } catch (e) {
              deps.showErrorToast("Skills install failed", e?.message || "Unknown error");
            }
            // Brief delay to let Roam settle after creating many blocks
            setTimeout(() => advanceStep(), 500);
          },
        },
        {
          label: "Skip for now",
          primary: false,
          onClick: () => {
            deps.iziToast.info({
              title: "Skills",
              message: "You can install them any time via the command palette: Chief of Staff: Bootstrap Skills Page.",
              timeout: 5000,
              position: "bottomRight",
            });
            advanceStep();
          },
        },
      ]));

      return frag;
    },
  },

  // ---- Step 9: External Tools (Composio) ----
  {
    id: "composio",
    skipIf: null,
    render(ctx) {
      const { advanceStep } = ctx;
      const frag = document.createDocumentFragment();

      frag.appendChild(createInfoText(
        "There are many ways we can work together, and one is to give me access to external tools. With those, I can check your email, read your calendar to create a day plan, manage tasks in Todoist, and much more."
      ));
      frag.appendChild(createInfoText(
        "I\u2019m fully capable within Roam on my own. With external tools, I gain superpowers."
      ));
      frag.appendChild(createInfoText(
        "The provider we use is <strong>Composio</strong> \u2014 it handles secure authentication to external services. Setting it up requires a few extra steps outside of Roam."
      ));

      // Track whether we're showing the expanded sub-view
      let expanded = false;

      const btnContainer = document.createElement("div");
      frag.appendChild(btnContainer);

      const renderButtons = () => {
        btnContainer.innerHTML = "";
        if (!expanded) {
          btnContainer.appendChild(createButtonGroup([
            {
              label: "Tell me more",
              primary: true,
              onClick: () => {
                expanded = true;
                renderButtons();
              },
            },
            {
              label: "Maybe later",
              primary: false,
              onClick: () => advanceStep(),
            },
          ]));
        } else {
          const details = document.createDocumentFragment();
          details.appendChild(createInfoText("To connect external tools:"));
          details.appendChild(createBulletList([
            "Sign up at <a href=\"https://composio.dev\" target=\"_blank\" rel=\"noopener\">composio.dev</a>",
            "Deploy the included CORS proxy (see the README for instructions)",
            "Add your Composio MCP URL and API key in Settings \u2192 Chief of Staff",
            "Run <strong>Chief of Staff: Connect Composio</strong> from the command palette",
            "Install tools by saying \u201cinstall google calendar\u201d in our chat",
          ]));
          details.appendChild(createInfoText(
            "Full instructions are in the README."
          ));
          details.appendChild(createButtonGroup([
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
              primary: false,
              onClick: () => advanceStep(),
            },
          ]));
          btnContainer.appendChild(details);
        }
      };

      renderButtons();
      return frag;
    },
  },

  // ---- Step 10: Finish ----
  {
    id: "finish",
    skipIf: null,
    render(ctx) {
      const { extensionAPI, deps, skipToEnd, sessionState } = ctx;
      const frag = document.createDocumentFragment();

      const userName = deps.getSettingString(extensionAPI, deps.SETTINGS_KEYS.userName, "");
      const safeName = userName ? ", " + deps.escapeHtml(userName) : "";
      frag.appendChild(createInfoText(
        `We\u2019re all set${safeName}. Here\u2019s a quick summary of what\u2019s configured:`
      ));

      // Build summary
      const provider = deps.getSettingString(extensionAPI, deps.SETTINGS_KEYS.llmProvider, "");
      const hasAnyKey = !!(
        deps.getSettingString(extensionAPI, deps.SETTINGS_KEYS.anthropicApiKey, "") ||
        deps.getSettingString(extensionAPI, deps.SETTINGS_KEYS.openaiApiKey, "") ||
        deps.getSettingString(extensionAPI, deps.SETTINGS_KEYS.geminiApiKey, "") ||
        deps.getSettingString(extensionAPI, deps.SETTINGS_KEYS.mistralApiKey, "")
      );
      const providerLabels = { anthropic: "Anthropic", openai: "OpenAI", gemini: "Gemini", mistral: "Mistral" };
      const providerLabel = providerLabels[provider] || "Not set";

      const summaryContainer = document.createElement("div");
      summaryContainer.className = "cos-onboarding-summary";
      summaryContainer.appendChild(createSummaryItem(`AI provider: ${providerLabel}`, hasAnyKey));

      // Memory pages — check if the main memory page exists
      let memoryCreated = false;
      try {
        const memResult = window.roamAlphaAPI?.data?.pull?.("[:node/title]", '[:node/title "Chief of Staff/Memory"]');
        memoryCreated = !!(memResult?.[":node/title"]);
      } catch { /* ignore */ }
      summaryContainer.appendChild(createSummaryItem(
        `Memory pages: ${memoryCreated ? "Created" : "Not yet"}`,
        memoryCreated
      ));

      // Skills
      let skillsCreated = false;
      try {
        const skillsResult = window.roamAlphaAPI?.data?.pull?.("[:node/title]", '[:node/title "Chief of Staff/Skills"]');
        skillsCreated = !!(skillsResult?.[":node/title"]);
      } catch { /* ignore */ }
      summaryContainer.appendChild(createSummaryItem(
        `Skills: ${skillsCreated ? "Installed" : "Not yet"}`,
        skillsCreated
      ));

      // Better Tasks — check both runtime API and user's onboarding choice
      const usesBT = sessionState.betterTasksEnabled || deps.hasBetterTasksAPI();
      summaryContainer.appendChild(createSummaryItem(
        `Better Tasks: ${usesBT ? "Enabled" : "Not using"}`,
        usesBT
      ));

      // External tools
      const composioUrl = deps.getSettingString(extensionAPI, deps.SETTINGS_KEYS.composioMcpUrl, "");
      const composioConfigured = !!composioUrl && composioUrl !== "enter your composio mcp url here";
      summaryContainer.appendChild(createSummaryItem(
        `External tools: ${composioConfigured ? "Configured" : "Set up later"}`,
        composioConfigured
      ));

      frag.appendChild(summaryContainer);

      frag.appendChild(createInfoText(
        "You can always revisit settings in <strong>Settings \u2192 Chief of Staff</strong>, or re-run this walkthrough from the command palette."
      ));

      frag.appendChild(createButtonGroup([
        {
          label: "Start working together",
          primary: true,
          onClick: () => {
            extensionAPI.settings.set(deps.SETTINGS_KEYS.onboardingComplete, true);

            // Conditional closing message
            if (deps.chatPanelIsOpen()) {
              setTimeout(() => {
                const msg = "Ready when you are. If you\u2019d like to see what I can do, try: \u201cRun my daily briefing\u201d or \u201cWhat was I working on?\u201d";
                deps.appendChatPanelMessage("assistant", msg);
                deps.appendChatPanelHistory("assistant", msg);
              }, 400);
            } else {
              deps.iziToast.success({
                title: "All set",
                message: "Open the command palette and run Chief of Staff: Ask whenever you need me.",
                timeout: 5000,
                position: "bottomRight",
              });
            }

            skipToEnd();
          },
        },
      ]));

      return frag;
    },
  },
];

export { ONBOARDING_STEPS };
