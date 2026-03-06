// LLM Service Module - handles API calls, prompt building, and story generation

var llmConfig = {
    provider: 'xai',
    model: '',
    language: 'en',
    enabled: true,
    availableProviders: [],
    useOwnKey: false,
    ownApiKey: ''
};

// Credit system
var INITIAL_FREE_CREDITS = 10;
var MILESTONE_STORY_COST = 1;
var REBIRTH_STORY_COST = 2;

// Milestone levels that trigger full LLM story generation
const milestoneLevels = [1, 10, 25, 50, 100, 200, 500, 1000];

// Throttle: prevent multiple simultaneous requests
var llmRequestPending = false;

// Queue for story generation requests
var storyQueue = [];
var processingQueue = false;

function getProviderCatalog() {
    return {
        xai: {
            id: 'xai',
            name: 'xAI (Grok)',
            baseUrl: 'https://api.x.ai/v1/chat/completions',
            defaultModel: 'grok-3'
        },
        openai: {
            id: 'openai',
            name: 'OpenAI',
            baseUrl: 'https://api.openai.com/v1/chat/completions',
            defaultModel: 'gpt-4o-mini'
        },
        deepseek: {
            id: 'deepseek',
            name: 'DeepSeek',
            baseUrl: 'https://api.deepseek.com/v1/chat/completions',
            defaultModel: 'deepseek-chat'
        }
    };
}

// ============================================================
// Provider Discovery
// ============================================================

async function fetchAvailableProviders() {
    var catalog = getProviderCatalog();
    var providers = [];
    for (var key in catalog) {
        providers.push({
            id: catalog[key].id,
            name: catalog[key].name,
            defaultModel: catalog[key].defaultModel
        });
    }
    llmConfig.availableProviders = providers;
    if (providers.length > 0 && !llmConfig.provider) {
        llmConfig.provider = providers[0].id;
    }
    return providers;
}

// ============================================================
// Prompt Templates
// ============================================================

function getGameContext() {
    var ctx = {
        age: daysToYears(gameData.days),
        day: getDay(),
        coins: gameData.coins,
        happiness: getHappiness().toFixed(1),
        evil: gameData.evil.toFixed(1),
        currentJob: tName(gameData.currentJob.name),
        currentJobLevel: gameData.currentJob.level,
        currentSkill: tName(gameData.currentSkill.name),
        currentSkillLevel: gameData.currentSkill.level,
        currentProperty: tName(gameData.currentProperty.name),
        rebirthCount: gameData.rebirthOneCount,
        darkRebirthCount: gameData.rebirthTwoCount,
        topJobs: [],
        topSkills: []
    };

    // Gather top leveled jobs & skills
    for (var name in gameData.taskData) {
        var task = gameData.taskData[name];
        if (task.level > 0) {
            if (task instanceof Job) {
                ctx.topJobs.push({ name: tName(name), level: task.level });
            } else {
                ctx.topSkills.push({ name: tName(name), level: task.level });
            }
        }
    }
    ctx.topJobs.sort(function(a, b) { return b.level - a.level; });
    ctx.topSkills.sort(function(a, b) { return b.level - a.level; });

    return ctx;
}

function getLanguageInstruction() {
    var langMap = {
        'en': 'Respond in English.',
        'zh': '请用中文回答。',
        'ja': '日本語で回答してください。',
        'ko': '한국어로 답변해 주세요.'
    };
    return langMap[llmConfig.language] || langMap['en'];
}

function getValidTargets() {
    var jobs = [];
    for (var cat in jobCategories) { jobs = jobs.concat(jobCategories[cat]); }
    var skills = [];
    for (var cat in skillCategories) { skills = skills.concat(skillCategories[cat]); }
    return { jobs: jobs, skills: skills };
}

function buildMilestonePrompt(taskName, taskType, newLevel, ctx) {
    var existingTooltip = tooltips[taskName] || '';
    var recentStories = getRecentStories(3);
    var recentStorySummary = recentStories.length > 0
        ? 'Recent events in this character\'s life:\n' + recentStories.map(function(s) { return '- ' + s.text; }).join('\n')
        : 'No notable events yet in this life.';

    var targets = getValidTargets();

    var prompt = 'You are a narrator for a medieval fantasy idle game called "Progress Knight". '
        + 'The player character is living a life from beggar to legend.\n\n'
        + getLanguageInstruction() + '\n\n'
        + 'CHARACTER STATE:\n'
        + '- Age: ' + ctx.age + ' years, Day ' + ctx.day + '\n'
        + '- Current Job: ' + ctx.currentJob + ' (level ' + ctx.currentJobLevel + ')\n'
        + '- Current Skill: ' + ctx.currentSkill + ' (level ' + ctx.currentSkillLevel + ')\n'
        + '- Housing: ' + ctx.currentProperty + '\n'
        + '- Happiness: ' + ctx.happiness + ', Evil: ' + ctx.evil + '\n'
        + '- Life number: ' + getCurrentLifeNumber() + ' (rebirths: ' + ctx.rebirthCount + ', dark: ' + ctx.darkRebirthCount + ')\n'
        + '- Top Jobs: ' + ctx.topJobs.slice(0, 5).map(function(j) { return j.name + '(' + j.level + ')'; }).join(', ') + '\n'
        + '- Top Skills: ' + ctx.topSkills.slice(0, 5).map(function(s) { return s.name + '(' + s.level + ')'; }).join(', ') + '\n\n'
        + 'VALID GAME ENTITIES (use these exact English names for "target"):\n'
        + '- Jobs: ' + targets.jobs.join(', ') + '\n'
        + '- Skills: ' + targets.skills.join(', ') + '\n\n'
        + 'PREVIOUS EVENTS:\n' + recentStorySummary + '\n\n'
        + 'CURRENT EVENT:\n'
        + 'The character\'s ' + taskType + ' "' + tName(taskName) + '" has reached level ' + newLevel + '.\n'
        + 'Flavor text for this ' + taskType + ': "' + existingTooltip + '"\n\n'
        + 'INSTRUCTIONS:\n'
        + 'Generate a short, vivid narrative (2-4 sentences) describing a unique personal experience or event that happened to the character as they reached this milestone. '
        + 'Make it feel personal and memorable - a specific encounter, discovery, battle, or moment of growth.\n\n'
        + 'Then suggest a small gameplay bonus the character earned from this experience. '
        + 'You MUST respond in this exact JSON format:\n'
        + '```json\n'
        + '{\n'
        + '  "story": "Your narrative text here",\n'
        + '  "effect": {\n'
        + '    "type": "xp_multiplier" | "income_bonus" | "happiness_boost" | "lifespan_bonus",\n'
        + '    "target": "exact English task/skill name from the VALID GAME ENTITIES list above, or empty string for global",\n'
        + '    "value": 0.05,\n'
        + '    "duration": "permanent" | "life"\n'
        + '  }\n'
        + '}\n'
        + '```\n'
        + 'IMPORTANT: The "target" field MUST be one of the exact English names listed in VALID GAME ENTITIES, or "" for a global bonus. '
        + 'Do NOT translate or invent target names.\n'
        + 'Keep the effect value small (0.02-0.20). All effect types use the same scale: 0.05 means +5% bonus. '
        + 'The effect should thematically match the story. "life" duration means it lasts until next rebirth. '
        + '"permanent" means it persists across rebirths. '
        + 'IMPORTANT: if Life number is 1 or 2, you MUST use "life" duration and keep value <= 0.08. '
        + 'If Life number is 3 or 4, use "life" duration and keep value <= 0.12. '
        + 'Only use "permanent" if Life number is 5 or higher.\n'
        + 'ONLY output the JSON, no other text.';

    return prompt;
}

function buildRebirthReviewPrompt(ctx) {
    var allStories = getLifeStories();
    var storySummary = allStories.length > 0
        ? allStories.map(function(s) { return '- [Age ' + daysToYears(s.day) + '] ' + s.text; }).join('\n')
        : 'A quiet, unremarkable life.';

    var targets = getValidTargets();

    var prompt = 'You are a narrator for a medieval fantasy idle game called "Progress Knight". '
        + 'The player character has reached the end of a life and is about to be reborn.\n\n'
        + getLanguageInstruction() + '\n\n'
        + 'LIFE SUMMARY:\n'
        + '- Lived to age: ' + ctx.age + '\n'
        + '- Highest Job: ' + (ctx.topJobs[0] ? ctx.topJobs[0].name + ' (lvl ' + ctx.topJobs[0].level + ')' : tName('Beggar')) + '\n'
        + '- Highest Skill: ' + (ctx.topSkills[0] ? ctx.topSkills[0].name + ' (lvl ' + ctx.topSkills[0].level + ')' : t('story_none')) + '\n'
        + '- Final Housing: ' + ctx.currentProperty + '\n'
        + '- Final Happiness: ' + ctx.happiness + ', Evil: ' + ctx.evil + '\n'
        + '- Total coins earned (approximate): ' + format(ctx.coins) + '\n'
        + '- Rebirth number: ' + ctx.rebirthCount + '\n\n'
        + 'VALID GAME ENTITIES (use these exact English names for "target"):\n'
        + '- Jobs: ' + targets.jobs.join(', ') + '\n'
        + '- Skills: ' + targets.skills.join(', ') + '\n\n'
        + 'KEY LIFE EVENTS:\n' + storySummary + '\n\n'
        + 'INSTRUCTIONS:\n'
        + 'Write a poetic, reflective "life review" narrative (4-6 sentences) summarizing this character\'s life. '
        + 'Reference specific events from the KEY LIFE EVENTS if available. '
        + 'End with a hint about what the next life might bring.\n\n'
        + 'Then suggest a rebirth bonus. Respond in this exact JSON format:\n'
        + '```json\n'
        + '{\n'
        + '  "story": "Your life review narrative here",\n'
        + '  "effect": {\n'
        + '    "type": "xp_multiplier" | "income_bonus" | "happiness_boost" | "lifespan_bonus",\n'
        + '    "target": "exact English task/skill name from VALID GAME ENTITIES, or empty string for global",\n'
        + '    "value": 0.05,\n'
        + '    "duration": "permanent"\n'
        + '  }\n'
        + '}\n'
        + '```\n'
        + 'IMPORTANT: The "target" field MUST be one of the exact English names listed in VALID GAME ENTITIES, or "" for a global bonus. '
        + 'Do NOT translate or invent target names.\n'
        + 'The rebirth bonus should be permanent and reflect the life lived. Value range: 0.02-0.15. All effect types use the same scale: 0.05 means +5% bonus.\n'
        + 'ONLY output the JSON, no other text.';

    return prompt;
}

// ============================================================
// API Call
// ============================================================

async function callLLM(prompt) {
    if (!llmConfig.enabled) return null;
    if (!llmConfig.useOwnKey || !llmConfig.ownApiKey) {
        addNotification(t('notif_no_own_key'));
        return null;
    }

    try {
        var catalog = getProviderCatalog();
        var provider = catalog[llmConfig.provider] || catalog.xai;
        var body = {
            model: llmConfig.model || provider.defaultModel,
            messages: [{ role: 'user', content: prompt }]
        };
        var res = await fetch(provider.baseUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + llmConfig.ownApiKey
            },
            body: JSON.stringify(body)
        });

        if (!res.ok) {
            var errText = await res.text();
            console.error('LLM API error:', errText);
            addNotification(t('notif_llm_request_failed'));
            return null;
        }

        var data = await res.json();
        var content = data.choices[0].message.content;

        // Extract JSON from response (handle markdown code blocks)
        var jsonMatch = content.match(/```json\s*([\s\S]*?)\s*```/);
        if (jsonMatch) {
            content = jsonMatch[1];
        }
        // Also try to find raw JSON
        content = content.trim();
        if (!content.startsWith('{')) {
            var braceStart = content.indexOf('{');
            if (braceStart >= 0) {
                content = content.substring(braceStart);
            }
        }

        return JSON.parse(content);
    } catch (err) {
        console.error('LLM call failed:', err);
        addNotification(t('notif_llm_request_failed'));
        return null;
    }
}

// ============================================================
// Story Generation
// ============================================================

function isMilestoneLevel(level) {
    for (var i = 0; i < milestoneLevels.length; i++) {
        if (level === milestoneLevels[i]) return true;
    }
    return false;
}

function getNextMilestone(currentLevel) {
    for (var i = 0; i < milestoneLevels.length; i++) {
        if (milestoneLevels[i] > currentLevel) return milestoneLevels[i];
    }
    return null;
}

function updateMilestoneIndicator() {
    var el = document.getElementById('nextMilestoneDisplay');
    if (!el) return;
    if (!llmConfig.enabled) {
        el.textContent = '';
        return;
    }
    // Show next milestone for current job (always) and skill (only when BYOK is active)
    var jobNext = getNextMilestone(gameData.currentJob.level);
    var skillNext = (llmConfig.useOwnKey && llmConfig.ownApiKey) ? getNextMilestone(gameData.currentSkill.level) : null;
    var parts = [];
    if (jobNext) parts.push(tName(gameData.currentJob.name) + ': ' + gameData.currentJob.level + '/' + jobNext);
    if (skillNext) parts.push(tName(gameData.currentSkill.name) + ': ' + gameData.currentSkill.level + '/' + skillNext);
    if (parts.length === 0) {
        el.textContent = t('milestone_all_done');
    } else {
        el.textContent = parts.join('  |  ');
    }
}

// ============================================================
// Credit System
// ============================================================

function initCredits() {
    if (typeof gameData.storyCredits === 'undefined' || gameData.storyCredits === null) {
        gameData.storyCredits = INITIAL_FREE_CREDITS;
    }
}

function getCredits() {
    initCredits();
    return gameData.storyCredits;
}

function hasEnoughCredits(cost) {
    if (llmConfig.useOwnKey && llmConfig.ownApiKey) return true;
    return getCredits() >= cost;
}

function spendCredits(cost) {
    if (llmConfig.useOwnKey && llmConfig.ownApiKey) return true;
    initCredits();
    if (gameData.storyCredits < cost) return false;
    gameData.storyCredits -= cost;
    updateCreditDisplay();
    return true;
}

function addCredits(amount) {
    initCredits();
    gameData.storyCredits += amount;
    updateCreditDisplay();
}

function updateCreditDisplay() {
    var el = document.getElementById('creditDisplay');
    if (!el) return;
    if (llmConfig.useOwnKey && llmConfig.ownApiKey) {
        el.textContent = t('credits_using_own_key');
        el.style.color = '#55a630';
    } else {
        el.textContent = getCredits() + t('credits_suffix');
        el.style.color = getCredits() > 0 ? '#E5C100' : '#e63946';
    }
}

function redeemCode(code) {
    // Simple code validation - in production, verify server-side
    var validCodes = {
        'FREESTORY10': 10,
        'FREESTORY25': 25,
        'FREESTORY50': 50
    };
    var upper = code.trim().toUpperCase();
    if (validCodes[upper]) {
        addCredits(validCodes[upper]);
        return { success: true, amount: validCodes[upper] };
    }
    return { success: false, amount: 0 };
}

function getFixedLevelUpText(taskName, taskType, level) {
    var templateKey = taskType === 'skill' ? 'levelup_skill' : 'levelup_job';
    var template = t(templateKey);
    return tName(taskName) + template.replace('{level}', level);
}

// ============================================================
// Pre-generated Story Fallback
// ============================================================

var _fallbackStories = null;   // null = not loaded yet, false = load failed
var _fallbackStoriesArr = [];  // raw array with history_bits for bitmask scoring

// Bit position for each job — mirrors JOB_BIT_INDEX in generate_stories.py
var _JOB_BIT = {
    'Beggar': 0, 'Farmer': 1, 'Fisherman': 2, 'Miner': 3, 'Blacksmith': 4, 'Merchant': 5,
    'Squire': 6, 'Footman': 7, 'Veteran footman': 8, 'Knight': 9,
    'Veteran knight': 10, 'Elite knight': 11, 'Holy knight': 12, 'Legendary knight': 13,
    'Student': 14, 'Apprentice mage': 15, 'Mage': 16,
    'Wizard': 17, 'Master wizard': 18, 'Chairman': 19
};

function _playerHistoryBits() {
    var bits = 0;
    for (var name in gameData.taskData) {
        var task = gameData.taskData[name];
        if (task instanceof Job && task.maxLevel > 0) {
            var idx = _JOB_BIT[name];
            if (idx !== undefined) bits |= (1 << idx);
        }
    }
    return bits;
}

function _popcount(n) {
    var count = 0;
    while (n) { count += n & 1; n >>>= 1; }
    return count;
}

function _levelBand(level) {
    if (level <= 9)   return 'low';
    if (level <= 49)  return 'mid';
    return 'high';
}

function _jobToSnake(taskName) {
    return taskName.toLowerCase().replace(/\s+/g, '_');
}

function _randomizeEffect(baseEffect, taskName) {
    // Deterministic seed per task+level so same milestone always gets same type/value
    var seed = 0;
    var str = taskName + (baseEffect.target || '') + (baseEffect.type || '');
    for (var i = 0; i < str.length; i++) { seed = (seed * 31 + str.charCodeAt(i)) | 0; }
    seed = Math.abs(seed);

    var types = ['xp_multiplier', 'income_bonus', 'happiness_boost', 'lifespan_bonus'];
    var type = types[seed % types.length];

    // Value: pick from a small set of meaningful values
    var values = [0.03, 0.04, 0.05, 0.06, 0.07, 0.08, 0.10];
    var value = values[(seed >> 3) % values.length];

    // Duration: permanent is possible in all lives but rarer in early ones
    var lifeNum = getCurrentLifeNumber();
    var durations = lifeNum <= 2
        ? ['life', 'life', 'life', 'life', 'life', 'permanent']
        : lifeNum <= 4
            ? ['life', 'life', 'life', 'permanent', 'permanent']
            : ['life', 'life', 'permanent', 'permanent', 'permanent'];
    var duration = durations[(seed >> 6) % durations.length];

    // Only xp_multiplier and income_bonus are job-targeted; others are always global
    var target = (type === 'xp_multiplier' || type === 'income_bonus') ? taskName : '';

    return {
        type: type,
        target: target,
        source: taskName,
        value: value,
        duration: duration
    };
}

async function _loadFallbackStories() {
    if (_fallbackStories !== null) return;
    var lang = llmConfig.language || 'en';
    var file = (lang === 'zh') ? 'js/stories_zh.json' : 'js/stories_en.json';
    try {
        var res = await fetch(file);
        if (!res.ok) throw new Error('HTTP ' + res.status);
        var arr = await res.json();
        _fallbackStoriesArr = arr;
        // Also build a fast key→text map for exact lookups
        _fallbackStories = {};
        for (var i = 0; i < arr.length; i++) {
            _fallbackStories[arr[i].key] = arr[i];
        }
    } catch(e) {
        console.warn('[Story] Fallback stories not available:', e.message);
        _fallbackStories = false;
    }
}

function _pickFallbackStory(taskName, level) {
    if (!_fallbackStories || !_fallbackStoriesArr.length) return null;

    var jobSnake  = _jobToSnake(taskName);
    var band      = _levelBand(level);
    var playerBits = _playerHistoryBits();

    // Score every story entry — do not pre-filter so job match dominates
    // Scoring weights:
    //   +100  current job exact match (must-have; dominates everything)
    //   +10   exact level band match
    //   +popcount(player_bits & story_bits)  career history overlap (max 20)
    var bestScore = -1;
    var candidates = [];
    for (var i = 0; i < _fallbackStoriesArr.length; i++) {
        var c = _fallbackStoriesArr[i];
        var score = 0;
        // Use word-boundary-style match: key segment must equal jobSnake exactly
        // e.g. "footman" must not match "veteran_footman"
        var keyParts = c.key.split('_');
        var jobParts = jobSnake.split('_');
        var jobLen = jobParts.length;
        var exactMatch = false;
        for (var j = 0; j <= keyParts.length - jobLen; j++) {
            if (keyParts.slice(j, j + jobLen).join('_') === jobSnake) { exactMatch = true; break; }
        }
        if (exactMatch) score += 100;
        if (c.key.indexOf('_' + band) !== -1) score += 10;
        if (typeof c.history_bits === 'number') {
            score += _popcount(playerBits & c.history_bits);
        }
        if (score > bestScore) { bestScore = score; candidates = [c]; }
        else if (score === bestScore) { candidates.push(c); }
    }
    // Only return a result if we found at least a job match
    if (!candidates.length || bestScore < 100) return null;
    // Pick deterministically by life number + task name so:
    //   - same life always gets the same story for a given task (consistent)
    //   - different lives get different stories (variety across rebirths)
    var seed = getCurrentLifeNumber() * 31 + taskName.length * 17 + level;
    return candidates[seed % candidates.length];
}

async function generateMilestoneStory(taskName, taskType, newLevel) {
    var hasKey = llmConfig.useOwnKey && llmConfig.ownApiKey;

    // Try LLM path first
    if (hasKey) {
        if (!hasEnoughCredits(MILESTONE_STORY_COST)) {
            addNotification(t('notif_no_credits'));
            return;
        }
        var ctx = getGameContext();
        var prompt = buildMilestonePrompt(taskName, taskType, newLevel, ctx);
        var result = await callLLM(prompt);

        if (result && result.story) {
            var scaledEffect = result.effect ? applyStoryEffect(result.effect, newLevel) : null;
            addStoryEntry({
                type: 'milestone',
                taskName: taskName,
                taskType: taskType,
                level: newLevel,
                day: gameData.days,
                text: result.story,
                effect: scaledEffect || null
            });
            spendCredits(MILESTONE_STORY_COST);
            showStoryModal(tName(taskName) + ' — ' + t('level_word') + ' ' + newLevel, result.story, scaledEffect);
            return;
        }
    }

    // Fallback: use pre-generated story
    await _loadFallbackStories();
    var fallback = _pickFallbackStory(taskName, newLevel);
    if (fallback) {
        var rawFallbackEffect = fallback.effect ? _randomizeEffect(fallback.effect, taskName) : null;
        var scaledFallbackEffect = rawFallbackEffect ? applyStoryEffect(rawFallbackEffect, newLevel) : null;
        addStoryEntry({
            type: 'milestone',
            taskName: taskName,
            taskType: taskType,
            level: newLevel,
            day: gameData.days,
            text: fallback.text,
            effect: scaledFallbackEffect || null
        });
        showStoryModal(tName(taskName) + ' — ' + t('level_word') + ' ' + newLevel, fallback.text, scaledFallbackEffect);
    }
}

async function generateRebirthReview() {
    if (!hasEnoughCredits(REBIRTH_STORY_COST)) {
        addNotification(t('notif_no_credits_rebirth'));
        return;
    }
    // Capture BEFORE any await — rebirthReset() runs synchronously after this call returns,
    // so by the time awaited LLM resolves, days and counts have already been reset.
    var lifeNum = getCurrentLifeNumber();  // not yet incremented — this IS the ending life
    var endingDay = gameData.days;         // capture before rebirthReset resets to day 365*14
    var ctx = getGameContext();
    var prompt = buildRebirthReviewPrompt(ctx);

    // Show loading modal and pause game
    showStoryModal(t('story_life_review') + ' — ' + getLifeLabel(lifeNum), t('story_review_loading'), null);

    var result = await callLLM(prompt);

    if (result && result.story) {
        if (result.effect) result.effect.duration = 'permanent';
        var scaledRebirthEffect = result.effect ? applyStoryEffect(result.effect, 0, true) : null;
        addStoryEntry({
            type: 'rebirth_review',
            taskName: '',
            taskType: '',
            level: 0,
            day: endingDay,
            lifeNumber: lifeNum,
            text: result.story,
            effect: scaledRebirthEffect || null
        });

        spendCredits(REBIRTH_STORY_COST);

        showStoryModal(t('story_life_review') + ' — ' + getLifeLabel(lifeNum), result.story, scaledRebirthEffect);
        if (typeof updateStoryLogUI === 'function') updateStoryLogUI();
        return;
    }

    // Fallback: use pre-generated rebirth story
    await _loadFallbackStories();
    if (_fallbackStories) {
        var rebirthKeys = ['rebirth_1', 'rebirth_2', 'rebirth_3'];
        var key = rebirthKeys[((gameData.rebirthOneCount || 0) + (gameData.rebirthTwoCount || 0)) % rebirthKeys.length];
        var fallback = _fallbackStories[key] || null;
        if (fallback) {
            var rebirthEffect = fallback.effect ? _randomizeEffect(fallback.effect, '') : null;
            if (rebirthEffect) rebirthEffect.duration = 'permanent';
            var scaledFallbackEffect = rebirthEffect ? applyStoryEffect(rebirthEffect, 0, true) : null;
            addStoryEntry({
                type: 'rebirth_review',
                taskName: '',
                taskType: '',
                level: 0,
                day: endingDay,
                lifeNumber: lifeNum,
                text: fallback.text,
                effect: scaledFallbackEffect || null
            });
            showStoryModal(t('story_life_review') + ' — ' + getLifeLabel(lifeNum), fallback.text, scaledFallbackEffect);
            if (typeof updateStoryLogUI === 'function') updateStoryLogUI();
            return;
        }
    }

    hideStoryModal();
}

// Queue-based story processing to avoid parallel API calls
function enqueueStory(taskName, taskType, newLevel) {
    storyQueue.push({ taskName: taskName, taskType: taskType, newLevel: newLevel });
    processStoryQueue();
}

async function processStoryQueue() {
    if (processingQueue || storyQueue.length === 0) return;
    processingQueue = true;

    while (storyQueue.length > 0) {
        // Wait if a modal (e.g. life review) is already open
        while (isStoryModalOpen()) {
            await new Promise(function(r) { setTimeout(r, 500); });
        }
        var item = storyQueue.shift();
        await generateMilestoneStory(item.taskName, item.taskType, item.newLevel);
    }

    processingQueue = false;
}

// ============================================================
// Level-up Handler (called from Task.increaseXp hook)
// ============================================================

function onLevelUp(taskName, taskType, oldLevel, newLevel) {
    // Check each level crossed
    for (var lvl = oldLevel + 1; lvl <= newLevel; lvl++) {
        if (isMilestoneLevel(lvl)) {
            enqueueStory(taskName, taskType, lvl);
        } else {
            // Fixed notification for non-milestone levels (only at intervals of 5)
            if (lvl % 5 === 0) {
                var text = getFixedLevelUpText(taskName, taskType, lvl);
                addNotification(text);
            }
        }
    }
}

// ============================================================
// Story Log Management
// ============================================================

function initStoryLog() {
    if (!gameData.storyLog) {
        gameData.storyLog = [];
    }
    if (!gameData.storyEffects) {
        gameData.storyEffects = [];
    }
    // Migrate old unscaled effects: re-apply scaleEffectForLife so display matches actual game values
    for (var i = 0; i < gameData.storyEffects.length; i++) {
        var eff = gameData.storyEffects[i];
        if (!eff.scaled) {
            var scaled = scaleEffectForLife(parseFloat(eff.value) || 0.05, eff.duration);
            eff.value = scaled.value;
            eff.duration = scaled.duration;
            eff.scaled = true;
        }
    }
    // Migrate unscaled effects on old storyLog entries so card display matches actual applied values
    // Also fix targets: re-derive from taskName so job-specific effects display correctly
    for (var i = 0; i < gameData.storyLog.length; i++) {
        var entry = gameData.storyLog[i];
        if (!entry.effect) continue;
        if (!entry.effect.scaled) {
            var s = scaleEffectForLife(parseFloat(entry.effect.value) || 0.05, entry.effect.duration);
            entry.effect.value = s.value;
            entry.effect.duration = s.duration;
            entry.effect.scaled = true;
        }
        // Fix target: if type uses a target and it's missing/unresolvable, use taskName
        if (!entry.effect.level && entry.level) {
            entry.effect.level = entry.level;
        }
        if (!entry.effect.source && entry.taskName) {
            entry.effect.source = entry.taskName;
        }
        if (!entry.effect.target_fixed) {
            var eType = entry.effect.type;
            if (eType === 'xp_multiplier' || eType === 'income_bonus') {
                if (entry.taskName && resolveTargetName(entry.effect.target) === '') {
                    entry.effect.target = entry.taskName;
                }
            } else {
                // happiness/lifespan are always global
                entry.effect.target = '';
            }
            entry.effect.target_fixed = true;
        }
    }
    // Also fix targets on storyEffects using storyLog as source of truth
    for (var i = 0; i < gameData.storyEffects.length; i++) {
        var eff = gameData.storyEffects[i];
        if (!eff.target_fixed) {
            var eType = eff.type;
            if (eType === 'happiness_boost' || eType === 'lifespan_bonus') {
                eff.target = '';
            } else if (eff.target && resolveTargetName(eff.target) === '') {
                for (var j = 0; j < gameData.storyLog.length; j++) {
                    var le = gameData.storyLog[j];
                    if (le.effect && le.effect.type === eType && le.taskName &&
                        Math.abs((parseFloat(le.effect.value) || 0) - (parseFloat(eff.value) || 0)) < 0.001) {
                        eff.target = le.taskName;
                        break;
                    }
                }
            }
            eff.target_fixed = true;
        }
        // Always back-fill source and level if missing (runs even on already target_fixed entries)
        if (!eff.source || !eff.level) {
            for (var j = 0; j < gameData.storyLog.length; j++) {
                var le = gameData.storyLog[j];
                if (le.effect && le.effect.type === eff.type && le.taskName &&
                    Math.abs((parseFloat(le.effect.value) || 0) - (parseFloat(eff.value) || 0)) < 0.001) {
                    if (!eff.source && le.taskName) eff.source = le.taskName;
                    if (!eff.level && le.level) eff.level = le.level;
                    break;
                }
            }
        }
    }
    // Back-fill lifeNumber for entries from old saves that lack it
    var life = 1;
    for (var i = 0; i < gameData.storyLog.length; i++) {
        if (!gameData.storyLog[i].lifeNumber) {
            gameData.storyLog[i].lifeNumber = life;
        }
        if (gameData.storyLog[i].type === 'rebirth_review') {
            life++;
        }
    }
}

function getCurrentLifeNumber() {
    return (gameData.rebirthOneCount || 0) + (gameData.rebirthTwoCount || 0) + 1;
}

function addStoryEntry(entry) {
    initStoryLog();
    entry.id = Date.now() + '_' + Math.random().toString(36).substr(2, 5);
    entry.lifeNumber = getCurrentLifeNumber();
    gameData.storyLog.push(entry);
}

function getRecentStories(count) {
    initStoryLog();
    return gameData.storyLog.slice(-count);
}

function getLifeStories() {
    initStoryLog();
    var lifeNum = getCurrentLifeNumber();
    return gameData.storyLog.filter(function(e) { return e.lifeNumber === lifeNum; });
}

function getStoriesForLife(lifeNum) {
    initStoryLog();
    return gameData.storyLog.filter(function(e) { return e.lifeNumber === lifeNum; });
}

function getTotalLives() {
    initStoryLog();
    return getCurrentLifeNumber();
}

// ============================================================
// Story Effect System
// ============================================================

function resolveTargetName(target) {
    if (!target || target === '') return '';
    // Already a valid internal name
    if (gameData.taskData[target] || gameData.itemData[target]) return target;
    // Try reverse-lookup from translated names
    for (var lang in nameTranslations) {
        var dict = nameTranslations[lang];
        for (var enName in dict) {
            if (dict[enName] === target) return enName;
        }
    }
    // Unrecognized target — default to global
    console.warn('[Story] Unrecognized effect target "' + target + '", defaulting to global');
    return '';
}

function normalizeEffectType(type) {
    if (!type) return 'xp_multiplier';
    type = type.toLowerCase().trim().replace(/[\s_-]+/g, '_');
    if (type === 'xp_multiplier' || type === 'xp_bonus' || type === 'experience_multiplier' || type === 'experience_bonus') return 'xp_multiplier';
    if (type === 'income_bonus' || type === 'income_multiplier' || type === 'coin_bonus') return 'income_bonus';
    if (type === 'happiness_boost' || type === 'happiness_bonus' || type === 'happiness_multiplier') return 'happiness_boost';
    if (type === 'lifespan_bonus' || type === 'lifespan_multiplier' || type === 'life_bonus') return 'lifespan_bonus';
    return type;
}

function scaleEffectForLife(rawValue, requestedDuration) {
    var lifeNum = getCurrentLifeNumber();
    var valueScale, duration;
    if (lifeNum <= 2) {
        // Early lives: small bonuses, never permanent
        valueScale = 0.5;
        duration = 'life';
    } else if (lifeNum <= 4) {
        // Mid-early lives: slightly larger, still no permanent
        valueScale = 0.75;
        duration = 'life';
    } else {
        // Life 5+: full value, permanent allowed
        valueScale = 1.0;
        duration = requestedDuration || 'life';
    }
    return {
        value: Math.min(Math.max(rawValue * valueScale, 0.01), 0.20),
        duration: duration
    };
}

function applyStoryEffect(effect, level, skipScale) {
    if (!effect || !effect.type) return;
    initStoryLog();

    var rawValue = parseFloat(effect.value) || 0.05;
    var scaled = skipScale
        ? { value: Math.min(Math.max(rawValue, 0.01), 0.20), duration: effect.duration || 'permanent' }
        : scaleEffectForLife(rawValue, effect.duration);
    var storyEffect = {
        type: normalizeEffectType(effect.type),
        target: resolveTargetName(effect.target),
        value: scaled.value,
        duration: scaled.duration,
        applied: true,
        scaled: true,
        level: level || 0,
        source: effect.source || ''
    };

    console.log('[Story] Life ' + getCurrentLifeNumber() + ' effect:', JSON.stringify(storyEffect), 'Total effects:', gameData.storyEffects.length + 1);
    gameData.storyEffects.push(storyEffect);
    recalculateStoryMultipliers();
    return storyEffect;
}

function getStoryXpMultiplier(taskName) {
    initStoryLog();
    var multiplier = 1;
    for (var i = 0; i < gameData.storyEffects.length; i++) {
        var eff = gameData.storyEffects[i];
        if (eff.type === 'xp_multiplier') {
            if (eff.target === '' || eff.target === taskName) {
                multiplier += eff.value;
            }
        }
    }
    return multiplier;
}

function getStoryIncomeMultiplier(taskName) {
    initStoryLog();
    var multiplier = 1;
    for (var i = 0; i < gameData.storyEffects.length; i++) {
        var eff = gameData.storyEffects[i];
        if (eff.type === 'income_bonus') {
            if (eff.target === '' || eff.target === taskName) {
                multiplier += eff.value;
            }
        }
    }
    return multiplier;
}

function getStoryHappinessBoost() {
    initStoryLog();
    var boost = 0;
    for (var i = 0; i < gameData.storyEffects.length; i++) {
        var eff = gameData.storyEffects[i];
        if (eff.type === 'happiness_boost') {
            boost += eff.value;
        }
    }
    return 1 + boost;
}

function getStoryLifespanMultiplier() {
    initStoryLog();
    var multiplier = 1;
    for (var i = 0; i < gameData.storyEffects.length; i++) {
        var eff = gameData.storyEffects[i];
        if (eff.type === 'lifespan_bonus') {
            multiplier += eff.value;
        }
    }
    return multiplier;
}

function recalculateStoryMultipliers() {
    // This is called after effects change; the actual multiplier functions
    // are bound via getStoryXpMultiplier etc. and queried each tick.
}

function clearLifeEffects() {
    // Remove "life" duration effects on rebirth
    initStoryLog();
    gameData.storyEffects = gameData.storyEffects.filter(function(eff) {
        return eff.duration === 'permanent';
    });
}

// ============================================================
// Notification System (for non-milestone level-ups)
// ============================================================

var notifications = [];
var maxNotifications = 5;

function addNotification(text) {
    notifications.push({ text: text, time: Date.now() });
    if (notifications.length > maxNotifications) {
        notifications.shift();
    }
    updateNotificationUI();
}

function updateNotificationUI() {
    var container = document.getElementById('notificationContainer');
    if (!container) return;
    container.innerHTML = '';
    for (var i = notifications.length - 1; i >= 0; i--) {
        var div = document.createElement('div');
        div.className = 'notification-item';
        div.textContent = notifications[i].text;
        container.appendChild(div);
    }
    // Auto-fade old notifications
    setTimeout(function() {
        if (notifications.length > 0 && Date.now() - notifications[0].time > 5000) {
            notifications.shift();
            updateNotificationUI();
        }
    }, 5000);
}

// ============================================================
// Story Modal UI
// ============================================================

function isStoryModalOpen() {
    var overlay = document.getElementById('storyModalOverlay');
    return overlay && overlay.style.display !== 'none';
}

function showStoryModal(title, storyText, effect) {
    var overlay = document.getElementById('storyModalOverlay');
    if (!overlay) return;

    // Pause the game while modal is shown
    if (typeof gameData !== 'undefined') gameData.paused = true;

    document.getElementById('storyModalTitle').textContent = title;
    document.getElementById('storyModalText').textContent = storyText;

    var effectEl = document.getElementById('storyModalEffect');
    if (effect) {
        var effectDesc = describeEffect(effect);
        effectEl.textContent = effectDesc;
        effectEl.style.display = 'block';
    } else {
        effectEl.style.display = 'none';
    }

    overlay.style.display = 'flex';
}

function hideStoryModal() {
    var overlay = document.getElementById('storyModalOverlay');
    if (overlay) overlay.style.display = 'none';
    // Unpause when modal closes
    if (typeof gameData !== 'undefined') gameData.paused = false;
}

function describeEffect(effect) {
    var typeMap = {
        xp_multiplier: 'effect_xp_multiplier',
        income_bonus: 'effect_income_bonus',
        happiness_boost: 'effect_happiness_boost',
        lifespan_bonus: 'effect_lifespan_bonus'
    };
    var durationMap = {
        permanent: 'effect_permanent',
        life: 'effect_life'
    };
    var typeName = t(typeMap[effect.type] || effect.type);
    var durName = t(durationMap[effect.duration] || effect.duration);
    var targetText = '';
    var sourceName = effect.target || effect.source || '';
    if (sourceName) {
        var lvlPart = effect.level ? ' ' + effect.level + t('level_word') : '';
        targetText = ' (' + tName(sourceName) + lvlPart + ')';
    }
    var displayValue = Math.min(Math.max(parseFloat(effect.value) || 0.05, 0.01), 0.20);
    var valueText = '+' + (displayValue * 100).toFixed(0) + '%';
    return '✦ ' + typeName + targetText + ': ' + valueText + ' [' + durName + ']';
}

// ============================================================
// Story Log Tab
// ============================================================

var selectedStoryLife = null;

function getLifeLabel(lifeNum) {
    var ordinals = [
        'life_1','life_2','life_3','life_4','life_5',
        'life_6','life_7','life_8','life_9','life_10'
    ];
    if (lifeNum >= 1 && lifeNum <= 10) {
        return t(ordinals[lifeNum - 1]);
    }
    return t('life_n').replace('{n}', lifeNum);
}

function renderStoryCards(container, entries) {
    if (entries.length === 0) {
        var empty = document.createElement('p');
        empty.style.color = 'gray';
        empty.textContent = t('story_no_stories');
        container.appendChild(empty);
        return;
    }
    for (var i = entries.length - 1; i >= 0; i--) {
        var entry = entries[i];
        var card = document.createElement('div');
        card.className = 'story-card';
        if (entry.type === 'rebirth_review') card.className += ' story-card-rebirth';

        var header = document.createElement('div');
        header.className = 'story-card-header';
        if (entry.type === 'rebirth_review') {
            header.textContent = t('story_log_header_rebirth').replace('{title}', t('story_life_review')).replace('{age}', daysToYears(entry.day));
            header.style.color = '#C71585';
        } else {
            header.textContent = t('story_log_header').replace('{name}', tName(entry.taskName)).replace('{level}', entry.level).replace('{age}', daysToYears(entry.day));
            header.style.color = '#E5C100';
        }

        var body = document.createElement('div');
        body.className = 'story-card-body';
        body.textContent = entry.text;

        card.appendChild(header);
        card.appendChild(body);

        if (entry.effect) {
            var effectDiv = document.createElement('div');
            effectDiv.className = 'story-card-effect';
            effectDiv.textContent = describeEffect(entry.effect);
            card.appendChild(effectDiv);
        }
        container.appendChild(card);
    }
}

function updateStoryLogUI() {
    var container = document.getElementById('storyLogContent');
    if (!container) return;

    initStoryLog();
    container.innerHTML = '';

    var totalLives = getTotalLives();

    if (gameData.storyLog.length === 0) {
        var empty = document.createElement('p');
        empty.style.color = 'gray';
        empty.textContent = t('story_no_stories');
        container.appendChild(empty);
        return;
    }

    // Default to current life tab
    if (selectedStoryLife === null || selectedStoryLife > totalLives) {
        selectedStoryLife = totalLives;
    }

    // Build life tab bar
    var tabBar = document.createElement('div');
    tabBar.className = 'story-life-tabs';
    for (var life = 1; life <= totalLives; life++) {
        (function(lifeNum) {
            var btn = document.createElement('button');
            btn.className = 'story-life-tab' + (lifeNum === selectedStoryLife ? ' active' : '');
            btn.textContent = getLifeLabel(lifeNum);
            btn.onclick = function() {
                selectedStoryLife = lifeNum;
                updateStoryLogUI();
            };
            tabBar.appendChild(btn);
        })(life);
    }
    container.appendChild(tabBar);

    // Render stories for selected life
    var entries = getStoriesForLife(selectedStoryLife);
    renderStoryCards(container, entries);
}

// ============================================================
// Active Story Effects Summary
// ============================================================

function updateActiveEffectsUI() {
    var container = document.getElementById('activeEffectsContent');
    if (!container) return;

    initStoryLog();
    container.innerHTML = '';

    if (gameData.storyEffects.length === 0) {
        var empty = document.createElement('p');
        empty.style.color = 'gray';
        empty.textContent = t('story_no_effects');
        container.appendChild(empty);
        return;
    }

    // Group effects by type
    var categories = ['xp_multiplier', 'income_bonus', 'happiness_boost', 'lifespan_bonus'];
    var typeMap = {
        xp_multiplier:   'effect_xp_multiplier',
        income_bonus:    'effect_income_bonus',
        happiness_boost: 'effect_happiness_boost',
        lifespan_bonus:  'effect_lifespan_bonus'
    };
    var groups = {};
    for (var i = 0; i < categories.length; i++) groups[categories[i]] = [];
    for (var i = 0; i < gameData.storyEffects.length; i++) {
        var eff = gameData.storyEffects[i];
        var key = eff.type || 'xp_multiplier';
        if (!groups[key]) groups[key] = [];
        groups[key].push(eff);
    }

    for (var ci = 0; ci < categories.length; ci++) {
        var cat = categories[ci];
        var items = groups[cat];
        if (!items || items.length === 0) continue;

        // Compute total for this category
        var total = 0;
        for (var j = 0; j < items.length; j++) total += parseFloat(items[j].value) || 0;

        var section = document.createElement('div');
        section.className = 'effect-group';

        // Header row — click to toggle
        var header = document.createElement('div');
        header.className = 'effect-group-header';
        var arrow = document.createElement('span');
        arrow.className = 'effect-group-arrow collapsed';
        arrow.textContent = '▶';
        var label = document.createElement('span');
        label.textContent = t(typeMap[cat]);
        var total_span = document.createElement('span');
        total_span.className = 'effect-group-total';
        total_span.textContent = '+' + (total * 100).toFixed(0) + '%  (' + items.length + ')';

        header.appendChild(arrow);
        header.appendChild(label);
        header.appendChild(total_span);

        // Detail list — collapsed by default
        var detail = document.createElement('div');
        detail.className = 'effect-group-detail collapsed';
        for (var j = 0; j < items.length; j++) {
            var row = document.createElement('div');
            row.className = 'effect-item';
            row.textContent = describeEffect(items[j]);
            detail.appendChild(row);
        }

        // Toggle on header click
        (function(arrowEl, detailEl) {
            header.addEventListener('click', function() {
                var isCollapsed = detailEl.classList.contains('collapsed');
                detailEl.classList.toggle('collapsed', !isCollapsed);
                arrowEl.classList.toggle('collapsed', !isCollapsed);
                arrowEl.textContent = isCollapsed ? '▼' : '▶';
            });
        })(arrow, detail);

        section.appendChild(header);
        section.appendChild(detail);
        container.appendChild(section);
    }
}

// ============================================================
// Settings persistence
// ============================================================

function saveLLMConfig() {
    localStorage.setItem('llmConfig', JSON.stringify({
        provider: llmConfig.provider,
        model: llmConfig.model,
        language: llmConfig.language,
        enabled: llmConfig.enabled,
        useOwnKey: llmConfig.useOwnKey,
        ownApiKey: llmConfig.ownApiKey
    }));
}

function detectBrowserLanguage() {
    var nav = (navigator.language || navigator.userLanguage || 'en').toLowerCase();
    if (nav.startsWith('zh')) return 'zh';
    if (nav.startsWith('ja')) return 'ja';
    if (nav.startsWith('ko')) return 'ko';
    return 'en';
}

function loadLLMConfig() {
    var saved = localStorage.getItem('llmConfig');
    if (saved) {
        var parsed = JSON.parse(saved);
        llmConfig.provider = parsed.provider || 'xai';
        llmConfig.model = parsed.model || '';
        llmConfig.language = parsed.language || detectBrowserLanguage();
        llmConfig.enabled = parsed.enabled !== false;
        llmConfig.useOwnKey = parsed.useOwnKey || false;
        llmConfig.ownApiKey = parsed.ownApiKey || '';
    } else {
        llmConfig.language = detectBrowserLanguage();
    }
    initCredits();
}
