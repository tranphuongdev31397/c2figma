# Eval log — prompt/schema tuning vs bench/compare.js

Append one entry per change, oldest first. Read the whole file before trying
something new — don't re-test a change already rejected here.

Template:

```
## YYYY-MM-DD — <what changed>
Provider/model: <ollama:qwen2.5vl:7b | openai:gpt-4o-mini | openai:gpt-4o>
Fixtures: <n> screens from bench/fixtures/
Score vs prior: IoU <before>→<after>, color ΔE <before>→<after>, text-match <before>→<after>%
Verdict: <kept | reverted> — <one line why>
```

(No entries yet — first real bench/compare.js run is pending implementation.)
