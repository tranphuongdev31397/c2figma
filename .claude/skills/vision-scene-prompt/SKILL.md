---
name: vision-scene-prompt
description: Tune or regenerate the vision-extraction prompt/schema used by src/image-scene.js (image→scene-graph, feeds the Figma renderer). Use when adding a vision provider, retuning the prompt after bench/compare.js scores come back, or changing NODE_SCHEMA fields.
---

# Vision Scene Prompt

Reusable knowledge for the image→Figma research path: a screenshot goes in, a
vision model returns wire-format nodes (`src/image-scene.js`), scored against
DOM ground truth (`bench/compare.js`) exported by the existing HTML capture
pipeline. This skill is the tuning workspace for that prompt — not the
pipeline code itself.

## Source of truth

The prompt and schema actually sent to the model live in `src/image-scene.js`
as JS constants (`PROMPT`, `NODE_SCHEMA`). `references/current-prompt.md` and
`references/node-schema.json` in this skill are the **documented, reviewable
copy** — keep them byte-identical to the code. If they drift, the code wins;
update the reference files to match, don't guess which is newer.

## Hard rules for this prompt (why, not just what)

- **English instructions, regardless of image content language.** UI screenshots here are Vietnamese, but instruction-following on the weak local model (qwen2.5vl:7b) is measurably more reliable in English. This overrides the project's usual "Vietnamese for user-facing strings" convention (CLAUDE.md) — that rule is for `figma.notify`/UI copy a human reads, not a system prompt sent to an API.
- **MUST / NEVER, not "quy tắc:" prose.** Stronger signal words survive truncation and skimming better than soft rule lists — learned from the `prompt-master` skill (see below).
- **Short and flat, not nested.** The binding constraint is the *weakest* target model, not the strongest. Ollama/qwen2.5vl loses coherence with deep nesting; GPT-4o loses nothing from a short prompt. Tune for the local model, let the hosted model ride along.
- **JSON Schema carries the format contract, not the prose.** `NODE_SCHEMA` (shared by both providers — Ollama `format`, OpenAI `response_format.json_schema`) enforces field types and required keys. The prompt only needs to carry *semantics* the schema can't express: what "parentId" means, how to pick a dominant color, naming convention.
- **Grounding anchor against fabrication.** Vision models will invent plausible-looking nodes or guess colors when a region is ambiguous. Explicit `NEVER invent... NEVER guess a color... use null` costs a few tokens and measurably cuts hallucinated nodes.

## Provider quirks (this project's two targets)

| Provider | Model | Notes |
|---|---|---|
| Ollama (local, free) | `qwen2.5vl:7b` | Shorter/simpler prompt wins. Set `temperature: 0.1` — extraction is a deterministic task, not creative. `format` field takes raw JSON Schema but may not reliably surface `description` strings to the model — put semantic meaning in the prompt body, not just schema descriptions. |
| OpenAI (hosted, ~$20 budget) | `gpt-4o-mini` for iteration, `gpt-4o` for ceiling runs | `response_format: {type:'json_schema', json_schema:{strict:true, schema}}` enforces the contract hard. No temperature override needed. |

Adding a third provider (Gemini, OpenRouter, etc.): read `references/provider-notes.md` in the sibling `prompt-master` skill (if present in this workspace) for that provider's general quirks, then add a row here with what actually worked — this table is project-specific findings, not a generic tuning guide.

## When retuning after a `bench/compare.js` run

1. Read `references/eval-log.md` before changing anything — a prior session may have already tried and rejected the change you're about to make.
2. Change one thing at a time (prompt wording, schema field, or `temperature`) — `compare.js` scores are only informative if you can attribute the delta.
3. Append the result to `references/eval-log.md`: what changed, IoU/color/text delta, which provider, one-line verdict.
4. Only after a change measurably helps, port it into `src/image-scene.js` and mirror it into `references/current-prompt.md`.

## Related

- `.claude/skills/prompt-master` in `finan-proweb-3.0` (sibling repo, not this one) — general-purpose per-tool prompt engineering reference (Claude, GPT, Gemini, Qwen, Ollama, agentic tools, image/video AI). This skill borrows its MUST/NEVER phrasing and per-tool routing table; go there for tools *outside* this project's two current providers.
- `docs/superpowers/specs/` — the full image→Figma research design doc (once written) has the wider pipeline context (schema origin, wire-format fields, bench harness).
