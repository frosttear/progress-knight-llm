"""
generate_stories.py
-------------------
Batch story generator for Progress Knight.
Calls xAI (Grok) to produce ~200 contextual stories covering all job/skill
progression paths, in both English and Chinese.

Output: js/stories_en.json and js/stories_zh.json
Key format: {job_snake_case}_{level_band}  e.g. "beggar_1", "knight_mid", "mage_high"
           For rebirth stories: "rebirth_1", "rebirth_2"

Usage:
    pip install requests

    # Recommended: set key in .env (copied from .env.example), then:
    python generate_stories.py                      # generate all ~63 combos, both languages
    python generate_stories.py --limit 5            # quick test with 5 stories
    python generate_stories.py --lang en            # English only
    python generate_stories.py --variants 3         # 3 story variants per combo (adds _v1/_v2/_v3 keys)

    # Or pass the key directly (no .env needed):
    python generate_stories.py --key xai-XXXXXXXX [--provider xai|openai|deepseek] [--lang en|zh|both] [--limit N] [--variants N]
"""

import argparse
import json
import os
import re
import sys
import requests

# ---------------------------------------------------------------------------
# Game data (mirrored from main.js)
# ---------------------------------------------------------------------------

JOB_CHAINS = {
    "common": [
        {"name": "Beggar",     "income": 5,       "key": "beggar"},
        {"name": "Farmer",     "income": 9,       "key": "farmer"},
        {"name": "Fisherman",  "income": 15,      "key": "fisherman"},
        {"name": "Miner",      "income": 40,      "key": "miner"},
        {"name": "Blacksmith", "income": 80,      "key": "blacksmith"},
        {"name": "Merchant",   "income": 150,     "key": "merchant"},
    ],
    "military": [
        {"name": "Squire",            "income": 5,      "key": "squire"},
        {"name": "Footman",           "income": 50,     "key": "footman"},
        {"name": "Veteran Footman",   "income": 120,    "key": "veteran_footman"},
        {"name": "Knight",            "income": 300,    "key": "knight"},
        {"name": "Veteran Knight",    "income": 1000,   "key": "veteran_knight"},
        {"name": "Elite Knight",      "income": 3000,   "key": "elite_knight"},
        {"name": "Holy Knight",       "income": 15000,  "key": "holy_knight"},
        {"name": "Legendary Knight",  "income": 50000,  "key": "legendary_knight"},
    ],
    "arcane": [
        {"name": "Student",         "income": 100,     "key": "student"},
        {"name": "Apprentice Mage", "income": 1000,    "key": "apprentice_mage"},
        {"name": "Mage",            "income": 7500,    "key": "mage"},
        {"name": "Wizard",          "income": 50000,   "key": "wizard"},
        {"name": "Master Wizard",   "income": 250000,  "key": "master_wizard"},
        {"name": "Chairman",        "income": 1000000, "key": "chairman"},
    ],
}

# Bit index for each job (20 jobs total, fits in a 20-bit integer)
JOB_BIT_INDEX = {
    # Common (bits 0-5)
    "Beggar":           0,
    "Farmer":           1,
    "Fisherman":        2,
    "Miner":            3,
    "Blacksmith":       4,
    "Merchant":         5,
    # Military (bits 6-13)
    "Squire":           6,
    "Footman":          7,
    "Veteran Footman":  8,
    "Knight":           9,
    "Veteran Knight":   10,
    "Elite Knight":     11,
    "Holy Knight":      12,
    "Legendary Knight": 13,
    # Arcane (bits 14-19)
    "Student":          14,
    "Apprentice Mage":  15,
    "Mage":             16,
    "Wizard":           17,
    "Master Wizard":    18,
    "Chairman":         19,
}


def history_to_bits(past_jobs: list, current_job: str) -> int:
    """Return a bitmask of all jobs the character has held (past + current)."""
    bits = 0
    for name in past_jobs + [current_job]:
        idx = JOB_BIT_INDEX.get(name)
        if idx is not None:
            bits |= (1 << idx)
    return bits


# Level bands applied per job: low / mid / high
LEVEL_BANDS = [
    {"band": "low",  "range": "1-10",   "desc": "just started"},
    {"band": "mid",  "range": "11-50",  "desc": "experienced"},
    {"band": "high", "range": "51-100", "desc": "mastered"},
]

# Typical career histories for each track (for context richness)
HISTORIES = {
    "common": [
        "Born into poverty with nothing but determination.",
        "Started as a beggar, learned to farm the land.",
        "Rose from fields to forge after years of toil.",
        "A self-made trader who worked every honest trade.",
    ],
    "military": [
        "Abandoned the commonfolk path to seek glory in battle.",
        "Trained body and mind, answered the call of war.",
        "Climbed the ranks through blood, discipline, and sacrifice.",
        "A veteran of countless campaigns seeking legendary status.",
    ],
    "arcane": [
        "Discovered an aptitude for magic after years of meditation.",
        "Left common work behind to join the Arcane Association.",
        "Devoted life to studying the mysteries of mana and time.",
        "A prodigy pushing the limits of magical knowledge toward chairmanship.",
    ],
    "rebirth": [
        "Has already lived once and carries the memories of a past life.",
        "Reborn with the wisdom of age — second life begins with purpose.",
        "Embraced evil in the last life; this time darkness flows in the veins.",
    ],
}

# ---------------------------------------------------------------------------
# Build combination list
# ---------------------------------------------------------------------------

def build_combinations():
    combos = []

    for track, jobs in JOB_CHAINS.items():
        chain_names = [j["name"] for j in jobs]
        for idx, job in enumerate(jobs):
            history_options = HISTORIES[track]
            # Use a representative history that grows with progression
            history_idx = min(idx, len(history_options) - 1)
            history = history_options[history_idx]
            past_jobs = chain_names[:idx]  # jobs completed before this one

            for band in LEVEL_BANDS:
                key = f"{track}_{job['key']}_{band['band']}"
                bits = history_to_bits(past_jobs, job["name"])
                combos.append({
                    "key": key,
                    "history_bits": bits,
                    "job": job["name"],
                    "track": track,
                    "level_range": band["range"],
                    "level_desc": band["desc"],
                    "income_per_day": job["income"],
                    "past_jobs": past_jobs,
                    "history_summary": history,
                })

    # Rebirth milestone stories
    for i, hist in enumerate(HISTORIES["rebirth"], 1):
        combos.append({
            "key": f"rebirth_{i}",
            "job": "(any)",
            "track": "rebirth",
            "level_range": "N/A",
            "level_desc": "life transition",
            "income_per_day": 0,
            "past_jobs": [],
            "history_summary": hist,
        })

    return combos


# ---------------------------------------------------------------------------
# API helpers
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# .env loader (no dependency on python-dotenv)
# ---------------------------------------------------------------------------

def load_env_file(path: str = ".env") -> dict:
    """Parse a .env file and return a dict of key=value pairs."""
    env = {}
    if not os.path.exists(path):
        return env
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            if "=" in line:
                k, _, v = line.partition("=")
                env[k.strip()] = v.strip().strip('"').strip("'")
    return env


ENV_KEY_MAP = {
    "xai":      "XAI_API_KEY",
    "openai":   "OPENAI_API_KEY",
    "deepseek": "DEEPSEEK_API_KEY",
}


def resolve_api_key(cli_key: str, provider: str, env: dict) -> str:
    """Return the API key: CLI arg > provider-specific env var > any available key."""
    if cli_key:
        return cli_key
    # Try the matching env var for the chosen provider
    specific = ENV_KEY_MAP.get(provider, "")
    if specific and env.get(specific):
        return env[specific]
    # Fall back to whichever key is present
    for p, var in ENV_KEY_MAP.items():
        if env.get(var):
            print(f"  Note: no key for provider '{provider}', using {var} instead")
            return env[var]
    return ""


def auto_detect_provider(env: dict) -> str:
    """Return the first provider whose key exists in the env."""
    for provider, var in ENV_KEY_MAP.items():
        if env.get(var):
            return provider
    return "xai"


PROVIDER_CONFIGS = {
    "xai": {
        "url": "https://api.x.ai/v1/chat/completions",
        "default_model": "grok-3",
    },
    "openai": {
        "url": "https://api.openai.com/v1/chat/completions",
        "default_model": "gpt-4o-mini",
    },
    "deepseek": {
        "url": "https://api.deepseek.com/v1/chat/completions",
        "default_model": "deepseek-chat",
    },
}


def call_llm(api_key: str, provider: str, model: str, prompt: str, max_tokens: int = 16000) -> str:
    cfg = PROVIDER_CONFIGS[provider]
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }
    payload = {
        "model": model or cfg["default_model"],
        "messages": [{"role": "user", "content": prompt}],
        "temperature": 0.85,
        "max_tokens": max_tokens,
    }
    resp = requests.post(cfg["url"], headers=headers, json=payload, timeout=180)
    resp.raise_for_status()
    return resp.json()["choices"][0]["message"]["content"]


def extract_json(raw: str) -> list:
    """Robustly extract a JSON array from LLM output that may have markdown fences."""
    # Strip markdown code fences
    raw = re.sub(r"```(?:json)?", "", raw).strip()
    # Find the outermost [ ... ]
    start = raw.find("[")
    end = raw.rfind("]")
    if start == -1 or end == -1:
        raise ValueError("No JSON array found in LLM response")
    return json.loads(raw[start:end + 1])


# ---------------------------------------------------------------------------
# Prompt builders
# ---------------------------------------------------------------------------

EN_STYLE = (
    "Epic, literary, second-person ('You...'), 100-150 words. "
    "Reflect on the character's past journey, celebrate current growth, "
    "and end with a hint of what lies ahead. Tone: inspiring, mythic."
)

ZH_STYLE = (
    '史诗文学风格，第二人称（\u201c你...\u201d），100-150字。'
    '回顾角色过去的旅程，赞颂当前成长，结尾预示下一步。风格：励志、史诗。'
    '请在故事末尾添加一个游戏效果（例如：获得10%的经验值加成，持续一生）。'
)

VALID_JOBS = [
    "Beggar", "Farmer", "Fisherman", "Miner", "Blacksmith", "Merchant",
    "Squire", "Footman", "Veteran Footman", "Knight", "Veteran Knight",
    "Elite Knight", "Holy Knight", "Legendary Knight",
    "Student", "Apprentice Mage", "Mage", "Wizard", "Master Wizard", "Chairman"
]

VALID_EFFECT_TYPES = ["xp_multiplier", "income_bonus", "happiness_boost", "lifespan_bonus"]


def build_prompt(combos: list, lang: str) -> str:
    style = EN_STYLE if lang == "en" else ZH_STYLE
    lang_label = "English" if lang == "en" else "中文"

    combo_list = json.dumps(combos, ensure_ascii=False, indent=2)
    valid_jobs_str = ", ".join(VALID_JOBS)

    return f"""You are a batch story generator for a fantasy idle/incremental game called Progress Knight.

Generate exactly {len(combos)} stories, one per combination below. Language: {lang_label}.
Style: {style}

Rules:
- Each story must be unique and reflect the specific job, level band, career history, and track.
- The "key" in your output MUST exactly match the "key" from the input.
- Output ONLY a valid JSON array. No markdown, no explanation, no extra text.
- Each entry must include a small gameplay bonus "effect" that thematically fits the story.
- Format each entry exactly as:
  {{"key": "...", "text": "...", "effect": {{"type": "xp_multiplier|income_bonus|happiness_boost|lifespan_bonus", "target": "exact job name or empty string for global", "value": 0.05, "duration": "permanent|life"}}}}
- "target" MUST be one of these exact English names (or "" for global): {valid_jobs_str}
- Effect value range: 0.02-0.15. The effect should match the story theme.

Combinations:
{combo_list}
"""


# ---------------------------------------------------------------------------
# Batching (LLMs have output token limits, so split into chunks)
# ---------------------------------------------------------------------------

CHUNK_SIZE = 15  # stories per API call


def load_existing(path: str) -> dict:
    """Load an existing JSON file into a key→entry dict, ignoring failed placeholders."""
    if not os.path.exists(path):
        return {}
    with open(path, encoding="utf-8") as f:
        arr = json.load(f)
    return {
        s["key"]: s for s in arr
        if not s.get("text", "").startswith("[Generation failed")
    }


def expand_combos_for_variants(combos: list, variants: int) -> list:
    """Return combos expanded with _v1, _v2, ... _vN variant keys."""
    if variants <= 1:
        return combos
    expanded = []
    for c in combos:
        for v in range(1, variants + 1):
            variant = dict(c)
            variant["key"] = f"{c['key']}_v{v}"
            expanded.append(variant)
    return expanded


def generate_all(api_key: str, provider: str, model: str, combos: list, lang: str,
                 existing: dict, variants: int = 1) -> dict:
    """Generate stories for combos not already in `existing`. Returns merged dict."""
    results = dict(existing)  # start with already-good entries

    # Expand combos to include variant keys if requested
    expanded = expand_combos_for_variants(combos, variants)

    # Only request combos that are missing or failed
    todo = [c for c in expanded if c["key"] not in results]
    if not todo:
        print(f"  [{lang}] All stories already generated, nothing to do.")
        return results

    chunks = [todo[i:i + CHUNK_SIZE] for i in range(0, len(todo), CHUNK_SIZE)]
    total = len(chunks)

    for idx, chunk in enumerate(chunks, 1):
        print(f"  [{lang}] Chunk {idx}/{total} ({len(chunk)} stories)...", end=" ", flush=True)
        prompt = build_prompt(chunk, lang)
        raw = None
        try:
            raw = call_llm(api_key, provider, model, prompt)
            parsed = extract_json(raw)
            for entry in parsed:
                results[entry["key"]] = entry
            print(f"OK ({len(parsed)} stories)")
        except Exception as e:
            print(f"FAILED: {e}")
            if raw:
                print("  Raw response snippet:", raw[:300])
            # Leave these keys out of results — they'll be retried next run

    return results


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    env = load_env_file()

    parser = argparse.ArgumentParser(description="Batch story generator for Progress Knight")
    parser.add_argument("--key",      default="",     help="LLM API key (overrides .env)")
    parser.add_argument("--provider", default="",     choices=["xai", "openai", "deepseek", ""], help="Provider (auto-detected from .env if omitted)")
    parser.add_argument("--model",    default="",     help="Model name (leave empty for provider default)")
    parser.add_argument("--limit",    default=None,   type=int, help="Cap number of combos (e.g. --limit 5 for a quick test; omit to generate all)")
    parser.add_argument("--variants", default=1,      type=int, help="Number of story variants to generate per combo (default 1; use 3+ for more rebirth variety)")
    parser.add_argument("--lang",     default="both", choices=["en", "zh", "both"])
    parser.add_argument("--out-en",   default="js/stories_en.json")
    parser.add_argument("--out-zh",   default="js/stories_zh.json")
    args = parser.parse_args()

    provider = args.provider or auto_detect_provider(env)
    api_key  = resolve_api_key(args.key, provider, env)

    if not api_key:
        print("Error: no API key found. Set XAI_API_KEY / OPENAI_API_KEY / DEEPSEEK_API_KEY in .env, or pass --key.")
        sys.exit(1)

    combos = build_combinations()
    total_available = len(combos)
    if args.limit is not None and args.limit < total_available:
        combos = combos[:args.limit]
    print(f"Built {total_available} combinations total; generating {len(combos)}.")
    print(f"Provider: {provider}  Model: {args.model or PROVIDER_CONFIGS[provider]['default_model']}")
    print()

    langs = ["en", "zh"] if args.lang == "both" else [args.lang]

    for lang in langs:
        out_file = args.out_en if lang == "en" else args.out_zh
        existing = load_existing(out_file)
        skip = len(existing)
        if skip:
            print(f"  [{lang}] Loaded {skip} existing stories from {out_file}, will skip those.")
        print(f"Generating {lang.upper()} stories → {out_file}")
        merged = generate_all(api_key, provider, args.model, combos, lang, existing, args.variants)

        output = list(merged.values())
        target = len(combos) * args.variants
        missing = target - len(output)

        with open(out_file, "w", encoding="utf-8") as f:
            json.dump(output, f, ensure_ascii=False, indent=2)

        if missing > 0:
            print(f"  Saved {len(output)} stories to {out_file} ({missing} still missing — re-run to retry)\n")
        else:
            print(f"  Saved {len(output)} stories to {out_file} (complete!)\n")

    print("Done!")
    print()
    print("Next step: place stories_en.json and stories_zh.json in the /js/ folder,")
    print("then the game will use them as fallback stories when no API key is configured.")


if __name__ == "__main__":
    main()
