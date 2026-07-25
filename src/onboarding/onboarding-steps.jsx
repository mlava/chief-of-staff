/** @jsx h */
/** @jsxFrag Frag */

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
 * Hard rules (shared with onboarding-ui.jsx):
 *   • React and Blueprint come from Roam at runtime (`window.React`,
 *     `window.Blueprint.Core`) — never `import` them.
 *   • Nothing in this module may touch window/document at module top level.
 *   • JSX compiles to the `h()` / `Frag` helpers from ./onboarding-ui.jsx via
 *     the `@jsx` / `@jsxFrag` pragmas at the top of this file.
 *   • Primary action buttons must carry data-cos-primary="true" (the `Buttons`
 *     helper does this for `{ primary: true }`) — the controller's Enter-key
 *     handler clicks the first `[data-cos-primary]` inside the card.
 */

import {
  h,
  InfoText,
  Hint,
  BulletList,
  Field,
  Buttons,
  Summary,
  SummaryItem,
  useInlineError,
  showToast,
  useAutoFocus,
  useAlive,
} from "./onboarding-ui.jsx";
import { ApiKeyStep, skipIfLlmConfigured, detectProvider } from "./steps-llm-setup.jsx";

// User-facing copy. InfoText/Hint render these as HTML — trusted literals only.
const COPY = {
  welcomeHello: "Welcome. I\u2019m your Chief of Staff \u2014 an AI assistant that lives inside your Roam graph.",
  welcomeSetup: "I\u2019d like to take a minute to get set up so I can start helping you. We can do this now, or you can configure everything manually in Roam Depot settings any time.",
  introAssistantName: "<strong>What would you like to call me?</strong><br>I\u2019ll answer to \u201cChief of Staff\u201d and any name you choose. You can change this later in settings.",
  btPitch: "Do you use the <strong>Better Tasks</strong> extension? I have deep integration with it \u2014 I can search, create, and manage tasks with full attribute support (projects, due dates, priorities, and more).",
  btWithout: "I work effectively without it too, using Roam\u2019s standard TODO/DONE blocks.",
  memoryPitch: "I\u2019d like to create a few pages in your graph for our shared working memory. These are my notebooks \u2014 you can read, edit, or delete them at any time.",
  questionnairePitch: "The more I know about you, the better I can help. I\u2019ve added a series of questions to <strong>[[Chief of Staff/Memory]]</strong> \u2014 things like your role, working style, and current priorities. Your answers become part of my context on every request.",
  hotkeyPitch: "I\u2019d recommend setting a keyboard shortcut for this \u2014 it makes reaching me much faster.",
  chatPanelPitch: "We can also talk via a floating chat panel \u2014 it\u2019s like having me on call in the corner of your screen. Persistent history, drag it where you like, pin responses to your daily page.",
  skillsPitch: "One of my best features is <strong>Skills</strong> \u2014 structured workflows I can execute end-to-end. Things like Daily Briefings, Weekly Reviews, Brain Dumps, Meeting Processing, and more.",
  skillsInstall: "I have a full set of built-in skills ready to install. They\u2019re templates \u2014 you can customise, rewrite, or delete any of them.",
  composioPitch: "I\u2019m fully capable within Roam on my own. With external tools, I gain superpowers.",
  composioProvider: "The provider we use is <strong>Composio</strong> \u2014 it handles secure authentication to external services. Setting it up requires a few extra steps outside of Roam.",
  mcpConfigure: "To set this up, add your server ports in <strong>Settings \u2192 Chief of Staff \u2192 Local MCP Server Ports</strong> (comma-separated, e.g. <code>8765,8766</code>), then run <strong>Chief of Staff: Connect Local MCP</strong> from the command palette.",
  mcpOptional: "<small>Full setup instructions are in the README. This is entirely optional \u2014 I work great without it.</small>",
  mcpPitch: "I can also connect to <strong>local MCP servers</strong> running on your machine \u2014 tools like Zotero, GitHub, or any custom server that speaks the Model Context Protocol.",
  mcpSupergateway: "If you run MCP servers via <strong>supergateway</strong> (which bridges stdio servers to SSE), I can connect to them directly in your browser. No proxy needed.",
  finishRevisit: "You can always revisit settings in <strong>Settings \u2192 Chief of Staff</strong>, or re-run this walkthrough from the command palette.",
};


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


// ---- Step 0: Welcome ----
function WelcomeStep({ ctx }) {
  const { extensionAPI, deps, advanceStep, skipToEnd } = ctx;

  return (
    <div>
      <InfoText html={COPY.welcomeHello} />
      <InfoText html={COPY.welcomeSetup} />
      <Buttons
        buttons={[
          { label: "Let\u2019s go", primary: true, onClick: () => advanceStep() },
          {
            label: "I\u2019ll set up manually",
            onClick: () => {
              extensionAPI.settings.set(deps.SETTINGS_KEYS.onboardingComplete, true);
              showToast(deps, "info", "No worries",
        "Open Settings \u2192 Chief of Staff whenever you\u2019re ready.", 5000);
              skipToEnd();
            },
          },
        ]}
      />
    </div>
  );
}

// ---- Step 1: Introductions ----
function skipIfIntroductions(ctx) {
  return !!ctx.extensionAPI?.settings?.get?.(ctx.deps?.SETTINGS_KEYS?.userName);
}

function IntroductionsStep({ ctx }) {
  const { useRef } = window.React;
  const { extensionAPI, deps, advanceStep } = ctx;
  const { setError, clearError, errorNode } = useInlineError();

  // Uncontrolled inputs, read on submit.
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
    showToast(deps, "success", "Hello",
        `Nice to meet you, ${deps.escapeHtml(userName)}. I\u2019m ${deps.escapeHtml(cosName)}.`);
    advanceStep();
  };

  return (
    <div>
      <InfoText html={"Let\u2019s start with introductions."} />
      <Field
        label="What should I call you?"
        placeholder="Your name"
        value={deps.getSettingString(extensionAPI, deps.SETTINGS_KEYS.userName, "")}
        inputRef={nameRef}
      />
      <InfoText html={COPY.introAssistantName} />
      <Field
        placeholder="Chief of Staff"
        value={deps.getAssistantDisplayName(extensionAPI)}
        inputRef={cosNameRef}
      />
      {errorNode}
      <Buttons
        buttons={[
          { label: "Continue \u2192", primary: true, onClick: onContinue },
        ]}
      />
    </div>
  );
}

// ---- Step 3: Better Tasks ----
function BetterTasksStep({ ctx }) {
  const { deps, advanceStep, sessionState } = ctx;

  return (
    <div>
      <InfoText html={COPY.btPitch} />
      <InfoText html={COPY.btWithout} />
      <Buttons
        buttons={[
          {
            label: "Yes, I use Better Tasks",
            primary: true,
            onClick: () => {
              // Read back by memory-pages (Projects bullet) and finish (summary).
              sessionState.betterTasksEnabled = true;
              showToast(deps, "success", "Better Tasks",
        "Excellent. I\u2019ll use Better Tasks for all task operations.");
              advanceStep();
            },
          },
          {
            label: "No, just standard TODOs",
            onClick: () => {
              sessionState.betterTasksEnabled = false;
              showToast(deps, "info", "Standard TODOs",
        "No problem. I\u2019ll work with standard TODO/DONE blocks. If you install Better Tasks later, I\u2019ll detect it automatically.", 5000);
              advanceStep();
            },
          },
        ]}
      />
    </div>
  );
}

// ---- Step 4: Memory Pages ----
function MemoryPagesStep({ ctx }) {
  const { useState } = window.React;
  const { deps, advanceStep, sessionState } = ctx;

  // Unmount guard for the pending runBootstrapMemoryPages() promise: the
  // user can close the card or navigate while it is still in flight, and a
  // dead step must never advance or set state.
  const alive = useAlive();

  // Busy guard: a double-click must not bootstrap twice.
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
      // Surfaced unconditionally \u2014 the user should learn the bootstrap
      // failed even if they navigated away.
      const errMsg = deps.escapeHtml(e?.message || "Unknown error");
      showToast(deps, "error", "Memory pages failed",
        `${errMsg}. You can try again later via the command palette: <strong>Chief of Staff: Bootstrap Memory Pages</strong>.`, 8000);
    }
    if (!alive.current) return;
    setBusy(false);
    // Vanilla advanced on both success and failure. Preserved.
    advanceStep();
  };

  return (
    <div>
      <InfoText html={COPY.memoryPitch} />
      <InfoText html={"I\u2019ll create:"} />
      <BulletList items={pages} />
      <InfoText html="May I create these now?" />
      <Buttons
        buttons={[
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
              showToast(deps, "info", "No worries",
        "You can create them later via the command palette: Chief of Staff: Bootstrap Memory Pages.", 5000);
              advanceStep();
            },
          },
        ]}
      />
    </div>
  );
}

// ---- Step 5: Memory Questionnaire ----
function MemoryQuestionnaireStep({ ctx }) {
  const { advanceStep, deps } = ctx;

  return (
    <div>
      <InfoText html={COPY.questionnairePitch} />
      <InfoText
        html="We can fill this in together now, or you can do it any time."
      />
      <Buttons
        buttons={[
          {
            label: "Open Memory page now",
            primary: true,
            onClick: () => {
              try {
                window.roamAlphaAPI.ui.mainWindow.openPage({
                  page: { title: "Chief of Staff/Memory" },
                });
              } catch { /* ignore if API unavailable */ }
              showToast(deps, "info", "Memory page opened",
        "Fill in what you can \u2014 even a few answers help.");
              advanceStep();
            },
          },
          {
            label: "I\u2019ll do it later",
            onClick: () => {
              showToast(deps, "info", "Memory",
        "No rush. You can open [[Chief of Staff/Memory]] any time to fill in your context \u2014 even a few answers make a difference.", 5000);
              advanceStep();
            },
          },
        ]}
      />
    </div>
  );
}

// ---- Step 6: Command Palette & Hotkey ----
function HotkeyStep({ ctx }) {
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
        showToast(deps, "info", "Hotkey setup",
        "Search for <strong>Edit Hotkey: Chief of Staff: Ask</strong> and choose your preferred shortcut.", 8000);
      } else {
        showToast(deps, "info", "Hotkey setup",
        "Open the command palette (<strong>Cmd+P</strong> or <strong>Ctrl+P</strong>), then search for <strong>Edit Hotkey: Chief of Staff: Ask</strong>.", 8000);
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

  return (
    <div>
      <InfoText html="You can ask me things via the command palette:" />
      <InfoText html="<strong>Chief of Staff: Ask</strong>" />
      <InfoText html={COPY.hotkeyPitch} />
      <Buttons
        buttons={[
          { label: "Set up hotkey now", primary: true, onClick: onSetUpHotkey },
          { label: "Skip", onClick: () => advanceStep() },
        ]}
      />
    </div>
  );
}

// ---- Step 7: Chat Panel ----
function ChatPanelStep({ ctx }) {
  const { extensionAPI, deps, advanceStep } = ctx;

  const onShowChatPanel = () => {
    if (!deps.chatPanelIsOpen()) deps.toggleChatPanel();
    showToast(deps, "success", "Chat panel", "There I am. Try typing something!");
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

  return (
    <div>
      <InfoText html={COPY.chatPanelPitch} />
      <Buttons
        buttons={[
          { label: "Show me the chat panel", primary: true, onClick: onShowChatPanel },
          { label: "Not now", onClick: () => advanceStep() },
        ]}
      />
    </div>
  );
}

// ---- Step 8: Skills ----
function SkillsStep({ ctx }) {
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

      showToast(deps, "success", "Skills installed", toastMsg, 6000);
    } catch (e) {
      const errMsg = deps.escapeHtml(e?.message || "Unknown error");
      showToast(deps, "error", "Skills install failed",
        `${errMsg}. You can try again later via the command palette: <strong>Chief of Staff: Bootstrap Skills Page</strong>.`, 8000);
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

  return (
    <div>
      <InfoText html={COPY.skillsPitch} />
      <InfoText html={COPY.skillsInstall} />
      <Buttons
        buttons={[
          { label: "Install skills", primary: true, onClick: onInstallSkills },
          {
            label: "Skip for now",
            onClick: () => {
              showToast(deps, "info", "Skills",
        "You can install them any time via the command palette: Chief of Staff: Bootstrap Skills Page.", 5000);
              advanceStep();
            },
          },
        ]}
      />
    </div>
  );
}

// ---- Step 9: External Tools (Composio) ----
function ComposioStep({ ctx }) {
  const { useState } = window.React;
  const { advanceStep } = ctx;

  // "Tell me more" swaps the button row for the detailed instructions.
  const [expanded, setExpanded] = useState(false);
  useAutoFocus([expanded], 50);

  return (
    <div>
      <InfoText
        html="There are many ways we can work together, and one is to give me access to external tools. With those, I can check your email, read your calendar to create a day plan, manage tasks in Todoist, and much more."
      />
      <InfoText html={COPY.composioPitch} />
      <InfoText html={COPY.composioProvider} />
      {expanded
        ? <div>
            <InfoText html="To connect external tools:" />
            <BulletList
              items={[
                "Sign up at <a href=\"https://composio.dev\" target=\"_blank\" rel=\"noopener\">composio.dev</a>",
                "Deploy the included CORS proxy (see the README for instructions)",
                "Add your Composio MCP URL and API key in Settings \u2192 Chief of Staff",
                "Run <strong>Chief of Staff: Connect Composio</strong> from the command palette",
                "Install tools by saying \u201cinstall google calendar\u201d in our chat",
              ]}
            />
            <InfoText html="Full instructions are in the README." />
            <Buttons
              buttons={[
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
                { label: "Done", onClick: () => advanceStep() },
              ]}
            />
          </div>
        : <div>
            <Buttons
              buttons={[
                {
                  label: "Tell me more",
                  primary: true,
                  onClick: () => setExpanded(true),
                },
                { label: "Maybe later", onClick: () => advanceStep() },
              ]}
            />
          </div>}
    </div>
  );
}

// ---- Step 10: Local MCP Servers ----
function LocalMcpStep({ ctx }) {
  const { useState, useRef } = window.React;
  const { extensionAPI, deps, advanceStep } = ctx;
  const { setError, clearError, errorNode } = useInlineError();

  const alive = useAlive();
  const busy = useRef(false);

  // Snapshot the connection state once: a failed connect attempt must not
  // re-branch the view.
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
    body = (
      <>
        <InfoText
          html={`<span class="cos-onboarding-accent">\u2713 Already connected to ${connectedCount} server${connectedCount > 1 ? "s" : ""}: <strong>${serverNames.join(", ")}</strong></span>`}
        />
        <Buttons
          buttons={[
            { label: "Continue \u2192", primary: true, onClick: () => advanceStep() },
          ]}
        />
      </>
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
        showToast(deps, "success", "Local MCP",
        `Connected to ${connected} server${connected > 1 ? "s" : ""}.`);
        if (!alive.current) return; // card is gone — don't advance a dead step
        advanceStep();
        return;
      }
      if (!alive.current) return; // unmounted — no state updates
      setError("Could not connect. Check that your servers are running and try again, or continue and connect later.");
    };

    body = (
      <>
        <InfoText
          html={`You have ports configured (<strong>${configuredPorts.map((p) => deps.escapeHtml(String(p))).join(", ")}</strong>) but no servers are connected yet. Make sure your supergateway is running, then connect.`}
        />
        <div>
          {errorNode}
          <Buttons
            buttons={[
              { label: "Try connecting now", primary: true, onClick: tryConnect },
              { label: "Skip", onClick: () => advanceStep() },
            ]}
          />
        </div>
      </>
    );
  } else {
    body = (
      <>
        <InfoText html={COPY.mcpConfigure} />
        <Hint html={COPY.mcpOptional} />
        <Buttons
          buttons={[
            { label: "Continue \u2192", primary: true, onClick: () => advanceStep() },
          ]}
        />
      </>
    );
  }

  return (
    <div>
      <InfoText html={COPY.mcpPitch} />
      <InfoText html={COPY.mcpSupergateway} />
      {body}
    </div>
  );
}

// ---- Step 11: Finish ----
function FinishStep({ ctx }) {
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

  return (
    <div>
      <InfoText
        html={`We\u2019re all set${safeName}. Here\u2019s a quick summary of what\u2019s configured:`}
      />
      <Summary>
        <SummaryItem key="provider" label={`AI provider: ${providerLabel}`} status={hasAnyKey} />
        <SummaryItem
          key="memory"
          label={`Memory pages: ${memoryCreated ? "Created" : "Not yet"}`}
          status={memoryCreated}
        />
        <SummaryItem
          key="skills"
          label={`Skills: ${skillsCreated ? "Installed" : "Not yet"}`}
          status={skillsCreated}
        />
        <SummaryItem
          key="better-tasks"
          label={`Better Tasks: ${usesBT ? "Enabled" : "Not using"}`}
          status={usesBT}
        />
        <SummaryItem
          key="composio"
          label={`External tools: ${composioConfigured ? "Configured" : "Set up later"}`}
          status={composioConfigured}
        />
        <SummaryItem
          key="local-mcp"
          label={`Local MCP: ${localConnected > 0 ? localConnected + " server" + (localConnected > 1 ? "s" : "") + " connected" : "Not configured"}`}
          status={localConnected > 0}
        />
      </Summary>
      <InfoText html={COPY.finishRevisit} />
      <Buttons
        buttons={[
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
                showToast(deps, "success", "All set",
        "Open the command palette and run Chief of Staff: Ask whenever you need me.", 5000);
              }

              skipToEnd();
            },
          },
        ]}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step manifest — order is the resume-logic contract (see loadOnboardingState
// and tests/onboarding.test.mjs); insertions/reorders break hardcoded resume
// indexes in onboarding.jsx.
// ---------------------------------------------------------------------------
const ONBOARDING_STEPS = [
  { id: "welcome", Component: WelcomeStep },
  { id: "introductions", skipIf: skipIfIntroductions, Component: IntroductionsStep },
  { id: "api-key", skipIf: skipIfLlmConfigured, Component: ApiKeyStep },
  { id: "better-tasks", Component: BetterTasksStep },
  { id: "memory-pages", Component: MemoryPagesStep },
  { id: "memory-questionnaire", Component: MemoryQuestionnaireStep },
  { id: "hotkey", Component: HotkeyStep },
  { id: "chat-panel", Component: ChatPanelStep },
  { id: "skills", Component: SkillsStep },
  { id: "composio", Component: ComposioStep },
  { id: "local-mcp", Component: LocalMcpStep },
  { id: "finish", Component: FinishStep },
];

export { ONBOARDING_STEPS, detectProvider };
