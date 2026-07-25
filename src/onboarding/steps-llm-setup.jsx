/** @jsx h */
/** @jsxFrag Frag */
/**
 * Step 2 — "Connect an AI model": chooser + api-key / ChatGPT-subscription /
 * custom-provider sub-views. Split from onboarding-steps.jsx as one cohesive
 * feature; ApiKeyStep is the dispatcher, each view resets by unmount.
 */

import {
  h,
  InfoText,
  Hint,
  Field,
  Select,
  Buttons,
  OptionCards,
  useInlineError,
  showToast,
  useAutoFocus,
  useAlive,
} from "./onboarding-ui.jsx";

// User-facing copy. InfoText/Hint render these as HTML — trusted literals only.
const COPY = {
  chooserIntro: "In order for me to think and work, I need access to an AI model. There are three ways to connect one — pick whichever suits you:",
  apiKeyIntro: "I support Anthropic Claude, OpenAI GPT, Google Gemini, Mistral, and Groq — paste a key from any of them and I’ll recognise which provider it belongs to. For Mistral keys (which have no distinctive prefix), choose your provider from the dropdown.",
  apiKeyPrivacy: "<small>Your key is stored locally in Roam and is only sent directly to your AI provider. It never passes through any other server.</small>",
  codexIntro: "Sign in with your ChatGPT Plus/Pro account — no API key needed. I’ll show you a one-time code; enter it on OpenAI’s sign-in page and we’re connected. <strong>(Experimental)</strong>",
  codexProxyCap: "<small>Heads-up: these calls route through Roam’s shared proxy, which caps long generations at ~60 seconds. Everyday queries are fine; for heavy skill runs an API key works better.</small>",
  customIntro: "Point me at any OpenAI-compatible endpoint — LM Studio, Ollama, OpenRouter, vLLM, or your own server.",
  customUrlHints: "<small>Base URL usually ends in /v1 — LM Studio: http://localhost:1234/v1, Ollama: http://localhost:11434/v1, OpenRouter: https://openrouter.ai/api/v1. Power/failover models and advanced options live in Settings → Chief of Staff.</small>",
};

function detectProvider(key) {
  if (!key) return null;
  if (key.startsWith("sk-ant-")) return "anthropic";
  if (key.startsWith("sk-")) return "openai";
  if (key.startsWith("AIza")) return "gemini";
  if (key.startsWith("gsk_")) return "groq";
  return null;
}

// ---------------------------------------------------------------------------
// Step 2 sub-views — module-level components. Never define components inside
// a component (a nested definition is a new type every render, remounting the
// subtree); and because these are separate components, leaving a view
// unmounts it, so its state resets without manual bookkeeping.
// ---------------------------------------------------------------------------

const LLM_SETUP_OPTIONS = [
  {
    view: "apikey",
    title: "API key",
    description:
      "Anthropic Claude, OpenAI GPT, Google Gemini, Mistral, or Groq — pay-as-you-go, most capable.",
  },
  {
    view: "codex",
    title: "ChatGPT subscription",
    description:
      "Use your ChatGPT Plus/Pro plan with a one-time sign-in code — no API key. (Experimental)",
  },
  {
    view: "custom",
    title: "Local or custom provider",
    description:
      "LM Studio, Ollama, OpenRouter, vLLM — any OpenAI-compatible endpoint.",
  },
];

const PROVIDER_LABELS = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  gemini: "Gemini",
  mistral: "Mistral",
  groq: "Groq",
};

const PROVIDER_DETECT_LABELS = {
  anthropic: "Anthropic (Claude)",
  openai: "OpenAI (GPT)",
  gemini: "Google (Gemini)",
  groq: "Groq (Llama)",
};

function LlmChooserView({ onPick }) {
  return (
    <div>
      <InfoText html={COPY.chooserIntro} />
      <OptionCards
        options={LLM_SETUP_OPTIONS.map((o) => ({
          title: o.title,
          description: o.description,
          onClick: () => onPick(o.view),
        }))}
      />
    </div>
  );
}

function LlmApiKeyView({ ctx, onBack }) {
  const { useState } = window.React;
  const { extensionAPI, deps, advanceStep } = ctx;
  const { setError, clearError, errorNode } = useInlineError();
  const [apiKey, setApiKey] = useState("");
  const [provider, setProvider] = useState("mistral");

  // Manual selector only for keys that can't be auto-detected.
  // Derived during render — no state/effect needed for four prefix checks.
  const probeVal = apiKey.trim();
  const detected = detectProvider(probeVal);
  const showManualSelect = !detected && !!probeVal;

  let feedback = null;
  if (detected) {
    feedback = (
      <span className="cos-onboarding-accent">
        {"✓ Detected: "}
        <strong>{PROVIDER_DETECT_LABELS[detected]}</strong>
      </span>
    );
  } else if (probeVal) {
    feedback = (
      <span className="cos-onboarding-muted">{"Select your provider below"}</span>
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
    showToast(deps, "success", `${PROVIDER_LABELS[chosen]} key saved`, "I’m ready to think.");
    advanceStep();
  };

  return (
    <div>
      <InfoText html={COPY.apiKeyIntro} />
      <Field
        placeholder="sk-... / AIza... / gsk_..."
        type="password"
        value={apiKey}
        onChange={(e) => setApiKey(e.target.value)}
      />
      {showManualSelect
        ? <Select
            label="Provider:"
            options={
              ["mistral", "anthropic", "openai", "gemini", "groq"].map((opt) => ({
                value: opt,
                label: opt.charAt(0).toUpperCase() + opt.slice(1),
              }))
            }
            value={provider}
            onChange={(e) => setProvider(e.currentTarget.value)}
          />
        : null}
      <div className="cos-onboarding-detected-provider">{feedback}</div>
      <Hint html={COPY.apiKeyPrivacy} />
      {errorNode}
      <Buttons
        buttons={[
          { label: "Save key →", primary: true, onClick: onSaveKey },
          { label: "← All options", onClick: onBack },
        ]}
      />
    </div>
  );
}

function LlmCodexView({ ctx, onBack }) {
  const { useState, useRef } = window.React;
  const { deps, advanceStep } = ctx;
  const { setError, clearError, errorNode } = useInlineError();
  const [waiting, setWaiting] = useState(false);
  // Monotonic token: an explicit cancel bumps it, so a cancelled attempt's
  // late-resolving promise can never be mistaken for the current attempt.
  // (Leaving the view unmounts this component — `alive` guards that path.)
  const connectAttempt = useRef(0);
  // Unmount guard for the pending connectCodex() promise.
  const alive = useAlive();

  const onConnect = async () => {
    if (waiting) return;
    const myAttempt = ++connectAttempt.current;
    setWaiting(true);
    clearError();
    const result = await deps.connectCodex();
    // Stale-guard: the user may have cancelled or navigated away while the
    // flow was pending.
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
          "Connection didn’t complete — try again."
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
    onBack();
  };

  return (
    <div>
      <InfoText html={COPY.codexIntro} />
      <Hint html={COPY.codexProxyCap} />
      {errorNode}
      <Buttons
        buttons={[
          {
            label: waiting ? "Waiting for sign-in…" : "Connect ChatGPT →",
            primary: true,
            disabled: waiting,
            onClick: onConnect,
          },
          { label: waiting ? "Cancel" : "← All options", onClick: onSecondary },
        ]}
      />
    </div>
  );
}

function LlmCustomProviderView({ ctx, onBack }) {
  const { useRef } = window.React;
  const { extensionAPI, deps, advanceStep } = ctx;
  const { setError, clearError, errorNode } = useInlineError();
  const nameRef = useRef(null);
  const urlRef = useRef(null);
  const apiKeyFieldRef = useRef(null);
  const modelRef = useRef(null);

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
    showToast(deps, "success", `${deps.escapeHtml(result.name)} configured`,
        "It’s now my primary model. Run “Check LLM Model Availability” from settings any time to verify it responds.", 5000);
    advanceStep();
  };

  return (
    <div>
      <InfoText html={COPY.customIntro} />
      <Field
        label="Name (optional)"
        placeholder="LM Studio / Ollama / OpenRouter"
        inputRef={nameRef}
      />
      <Field
        label="Base URL"
        placeholder="http://localhost:1234/v1"
        inputRef={urlRef}
      />
      <Field
        label="API key (optional)"
        placeholder="Leave blank for LM Studio / Ollama"
        type="password"
        inputRef={apiKeyFieldRef}
      />
      <Field
        label="Model"
        placeholder="e.g. llama-3.1-8b-instruct"
        inputRef={modelRef}
      />
      <Hint html={COPY.customUrlHints} />
      {errorNode}
      <Buttons
        buttons={[
          { label: "Save provider →", primary: true, onClick: onSaveProvider },
          { label: "← All options", onClick: onBack },
        ]}
      />
    </div>
  );
}


// ---- Step 2: Connect an AI model ----
function skipIfLlmConfigured(ctx) {
  // Any configured path counts: built-in/legacy key, ChatGPT
  // subscription, or a custom slot.
  return !!ctx.deps.hasAnyLlmConfigured?.(ctx.extensionAPI);
}

function ApiKeyStep({ ctx }) {
  const { useState } = window.React;
  // Sub-view switcher: chooser → apikey | codex | custom. Each view is
  // its own component, so leaving it resets its state via unmount.
  const [view, setView] = useState("chooser");
  // The controller's auto-focus only fires on step render, so focus the
  // first input ourselves after a sub-view swap.
  useAutoFocus([view], 50);
  const showChooser = () => setView("chooser");
  if (view === "apikey") return <LlmApiKeyView ctx={ctx} onBack={showChooser} />;
  if (view === "codex") return <LlmCodexView ctx={ctx} onBack={showChooser} />;
  if (view === "custom") return <LlmCustomProviderView ctx={ctx} onBack={showChooser} />;
  return <LlmChooserView onPick={setView} />;
}

export { ApiKeyStep, skipIfLlmConfigured, detectProvider };
