# AI Agent Security

**Developer Reference & Implementation Checklist**

Compiled February 2026

Sources: OWASP, Google, NIST, MITRE

*For agent developers building autonomous AI systems*

---

## Part 1: Framework Reference Guide

Seven key frameworks and resources specifically addressing AI agent security for developers. These range from actionable top-10 risk lists to strategic government initiatives.

| # | Framework | Source | Agent Dev Focus | URL |
|---|-----------|--------|-----------------|-----|
| 1 | **OWASP Top 10 for Agentic Applications (2026)** | OWASP | 10 highest-impact risks for autonomous agents with actionable mitigations | [Link](https://genai.owasp.org/resource/owasp-top-10-for-agentic-applications-for-2026/) |
| 2 | **OWASP Agentic AI Threats & Mitigations (v1.1)** | OWASP | Foundational taxonomy of agent threats; baseline definitions and detailed treatment | [Link](https://genai.owasp.org/) |
| 3 | **OWASP Securing Agentic Applications Guide** | OWASP | Architecture, design, development, and deployment security patterns | [Link](https://genai.owasp.org/) |
| 4 | **OWASP Agentic Threat Modelling Guide** | OWASP | Structured threat modelling methodology for agentic systems | [Link](https://genai.owasp.org/) |
| 5 | **Google Secure AI Agents Whitepaper** | Google | Hybrid defense-in-depth: runtime policy engines + reasoning-based defenses | [Link](https://storage.googleapis.com/gweb-research2023-media/pubtools/1018686.pdf) |
| 6 | **NIST AI Agent Standards Initiative** | NIST | Agent standards, protocol development, security & identity research | [Link](https://www.nist.gov/news-events/news/2026/02/announcing-ai-agent-standards-initiative-interoperable-and-secure) |
| 7 | **MITRE ATLAS Agentic Techniques** | MITRE | 14 new adversarial techniques for AI agents (Oct 2025 update) | [Link](https://atlas.mitre.org/) |

### 1. OWASP Top 10 for Agentic Applications (2026)

The most directly actionable resource for agent developers. Published December 2025 with input from 100+ experts. Covers the ten highest-impact risks specific to autonomous, tool-using, multi-agent systems. Each entry includes vulnerability patterns, attack scenarios, and concrete mitigations.

**The 10 risks:** ASI01 Agent Goal Hijack, ASI02 Tool Misuse & Exploitation, ASI03 Identity & Privilege Abuse, ASI04 Agentic Supply Chain Vulnerabilities, ASI05 Unexpected Code Execution, ASI06 Memory & Context Poisoning, ASI07 Insecure Inter-Agent Communication, ASI08 Cascading Failures, ASI09 Human-Agent Trust Exploitation, ASI10 Rogue Agents.

**Key concept -- Least Agency:** Only grant agents the minimum autonomy required to perform safe, bounded tasks. This extends least privilege into the agentic domain.

### 2. OWASP Agentic AI Threats & Mitigations (v1.1)

The foundational taxonomy underpinning the Top 10. Provides baseline definitions of agents, their relationship to LLM applications, the role of autonomy, and a comprehensive treatment of threats and mitigations. Already referenced by Microsoft and AWS in their own agentic security guidance.

### 3. OWASP Securing Agentic Applications Guide

Covers the full development lifecycle: architecture patterns, secure design principles, development practices, and deployment considerations for agentic systems. Practical companion to the threat taxonomy.

### 4. OWASP Agentic Threat Modelling Guide

Structured methodology for threat modelling agentic systems. Referenced by NVIDIA in their Safety and Security Framework for Real-World Agentic Systems. Helps teams systematically identify where agent-specific risks arise in their particular architecture.

### 5. Google Secure AI Agents Whitepaper (May 2025)

Companion to Google's SAIF framework, specifically addressing agentic AI. Proposes three core security principles and a hybrid defense-in-depth strategy.

- **Principle 1:** Agents must have well-defined human controllers
- **Principle 2:** Agent powers must have limitations (dynamic least privilege)
- **Principle 3:** Agent actions and planning must be observable

The hybrid approach layers deterministic runtime policy enforcement (hard guardrails outside the model) with reasoning-based defenses (adversarial training, guard models, plan analysis). Neither is sufficient alone.

### 6. NIST AI Agent Standards Initiative (Feb 2026)

Announced February 2026. Three pillars: facilitating industry-led agent standards and U.S. leadership in international standards bodies; fostering community-led open source protocol development; and advancing research in AI agent security and identity. Includes an active RFI on AI agent security (closes March 9, 2026) and a concept paper on AI Agent Identity and Authorization (due April 2).

### 7. MITRE ATLAS Agentic Techniques (Oct 2025)

The October 2025 update to the ATLAS adversarial ML knowledge base added 14 new techniques specifically targeting AI agents, developed in collaboration with Zenity Labs. Covers autonomous agent security risks including prompt injection, memory manipulation, and tool exploitation. Complements OWASP and NIST rather than competing with them.

---

## Part 2: Agent Security Implementation Checklist

Synthesised from all seven frameworks above. Organised by development phase. Use as a working checklist during agent design, build, and deployment.

### A. Design & Architecture

| | Control | Implementation Notes |
|---|---------|---------------------|
| &#9744; | **Define agent scope and purpose** | What is this agent allowed to do? Document boundaries explicitly. (Google P2, OWASP ASI01) |
| &#9744; | **Map trust boundaries** | Identify trusted vs untrusted inputs. Separate user commands from contextual data. (Google P1, OWASP ASI01) |
| &#9744; | **Enumerate all tools and actions** | Catalogue every API, database, and external system the agent can access. (OWASP ASI02) |
| &#9744; | **Apply least agency principle** | Grant minimum autonomy needed. Default to restricted; expand deliberately. (OWASP core concept) |
| &#9744; | **Design for human oversight** | Identify which actions require confirmation. Define escalation paths. (Google P1) |
| &#9744; | **Threat model the agent architecture** | Use OWASP Agentic Threat Modelling Guide. Map to MITRE ATLAS techniques. |
| &#9744; | **Plan for multi-agent isolation** | If using multiple agents, define identity, permission, and memory boundaries between them. (OWASP ASI07) |
| &#9744; | **Document the AI Bill of Materials** | Track models, datasets, tools, plugins, and MCP servers. (OWASP ASI04, CycloneDX AIBOM) |

### B. Development & Build

| | Control | Implementation Notes |
|---|---------|---------------------|
| &#9744; | **Implement runtime policy engine** | Deterministic guardrails outside the model that intercept and evaluate actions before execution. (Google Layer 1) |
| &#9744; | **Add reasoning-based defenses** | Guard models, adversarial training, plan analysis as a second layer. (Google Layer 2) |
| &#9744; | **Enforce input separation** | Use structural delimiters to distinguish system instructions, user input, and external data. (Google, OWASP ASI01) |
| &#9744; | **Scope credentials dynamically** | Use short-lived, scoped OAuth tokens. Never give agents persistent broad access. (Google P2, OWASP ASI03) |
| &#9744; | **Sandbox code execution** | Any agent-generated code runs in isolated environments with no access to host resources. (OWASP ASI05) |
| &#9744; | **Protect agent memory** | Validate and sanitise data before writing to memory. Isolate memory per user/context. (OWASP ASI06) |
| &#9744; | **Validate tool descriptions** | Verify third-party tool/MCP server descriptions are not deceptive or malicious. (OWASP ASI04) |
| &#9744; | **Sanitise all output rendering** | Prevent XSS, data exfiltration via crafted URLs, and Markdown injection. (Google) |
| &#9744; | **Implement DLP on agent outputs** | Filter outputs for PII, credentials, and sensitive data before they reach users or other systems. (OWASP ASI06) |
| &#9744; | **Secure inter-agent protocols** | Authenticate agent-to-agent communication. Validate message schemas and semantics. (OWASP ASI07) |

### C. Deployment & Operations

| | Control | Implementation Notes |
|---|---------|---------------------|
| &#9744; | **Assign unique agent identities** | Each agent instance gets verifiable identity and credentials that can be tracked and revoked. (Google P1, NIST) |
| &#9744; | **Implement comprehensive logging** | Log inputs, tool invocations, parameters, outputs, and reasoning steps. Protect sensitive data in logs. (Google P3) |
| &#9744; | **Set up behavioural monitoring** | Establish baselines. Alert on anomalous tool usage patterns, permission escalation attempts, or drift. (MITRE ATLAS) |
| &#9744; | **Define and enforce action limits** | Spending caps, rate limits, scope restrictions. Hard limits enforced deterministically. (Google Layer 1) |
| &#9744; | **Configure kill switches** | Ability to immediately revoke agent permissions and halt execution. (OWASP ASI10) |
| &#9744; | **Plan for cascading failure** | Test blast radius. What happens if one agent in a chain is compromised? Contain propagation. (OWASP ASI08) |
| &#9744; | **Enable user inspection controls** | Users can view what the agent accessed, what actions it took, and revoke permissions. (Google P1, P3) |
| &#9744; | **Vet supply chain continuously** | Monitor dependencies, MCP servers, plugins, and models for tampering or compromise. (OWASP ASI04, MITRE) |

### D. Testing & Assurance

| | Control | Implementation Notes |
|---|---------|---------------------|
| &#9744; | **Red team for prompt injection** | Test indirect injection via documents, emails, web content the agent processes. (MITRE ATLAS, Google) |
| &#9744; | **Test memory poisoning paths** | Attempt to embed persistent malicious instructions via agent memory. (OWASP ASI06) |
| &#9744; | **Validate policy engine coverage** | Ensure guardrails catch high-risk actions even when reasoning is compromised. (Google Layer 1) |
| &#9744; | **Run regression tests on fixes** | Ensure security patches remain effective over time as agent capabilities evolve. (Google) |
| &#9744; | **Perform variant analysis** | Proactively test variations of known attacks to anticipate attacker evolution. (Google) |
| &#9744; | **Test trust exploitation scenarios** | Can the agent persuade users to take harmful actions? Test for over-reliance. (OWASP ASI09) |
| &#9744; | **Replay agent sessions** | Re-run recorded agent action sequences in isolated environments to check for cascading failures. (OWASP ASI08) |
| &#9744; | **Conduct supply chain audits** | Verify integrity of all third-party tools, models, and data sources. (OWASP ASI04) |

### Cross-Reference: OWASP ASI Risks to Checklist Items

| OWASP Risk | Risk Name | Key Checklist Items |
|------------|-----------|---------------------|
| **ASI01** | Agent Goal Hijack | Map trust boundaries, Enforce input separation, Red team for prompt injection |
| **ASI02** | Tool Misuse & Exploitation | Enumerate all tools, Runtime policy engine, Validate policy engine coverage |
| **ASI03** | Identity & Privilege Abuse | Scope credentials dynamically, Assign unique agent identities, Configure kill switches |
| **ASI04** | Supply Chain Vulnerabilities | Document AI BOM, Validate tool descriptions, Vet supply chain continuously |
| **ASI05** | Unexpected Code Execution | Sandbox code execution, Runtime policy engine |
| **ASI06** | Memory & Context Poisoning | Protect agent memory, Implement DLP, Test memory poisoning paths |
| **ASI07** | Insecure Inter-Agent Comms | Plan for multi-agent isolation, Secure inter-agent protocols |
| **ASI08** | Cascading Failures | Plan for cascading failure, Replay agent sessions |
| **ASI09** | Human-Agent Trust Exploitation | Design for human oversight, Test trust exploitation scenarios |
| **ASI10** | Rogue Agents | Behavioural monitoring, Configure kill switches, Regression tests |
