// ============================================================
// Internationalization (i18n) Module - Core
// ============================================================

var currentLanguage = 'en';

function t(key) {
    var dict = translations[currentLanguage] || translations['en'];
    if (dict[key] !== undefined) return dict[key];
    if (translations['en'][key] !== undefined) return translations['en'][key];
    return key;
}

function tName(entityName) {
    var dict = nameTranslations[currentLanguage] || nameTranslations['en'];
    return dict[entityName] || entityName;
}

function tTooltip(entityName) {
    var dict = tooltipTranslations[currentLanguage] || tooltipTranslations['en'];
    return dict[entityName] || tooltips[entityName] || entityName;
}

function tCategory(categoryName) {
    var dict = categoryTranslations[currentLanguage] || categoryTranslations['en'];
    return dict[categoryName] || categoryName;
}

function tDesc(description) {
    var dict = descriptionTranslations[currentLanguage] || descriptionTranslations['en'];
    return dict[description] || description;
}

function setLanguage(lang) {
    currentLanguage = lang;
    llmConfig.language = lang;
    saveLLMConfig();
    applyLanguageToUI();
}

function applyLanguageToUI() {
    var els = document.querySelectorAll('[data-i18n]');
    for (var i = 0; i < els.length; i++) {
        els[i].textContent = t(els[i].getAttribute('data-i18n'));
    }
    var placeholders = document.querySelectorAll('[data-i18n-placeholder]');
    for (var i = 0; i < placeholders.length; i++) {
        placeholders[i].placeholder = t(placeholders[i].getAttribute('data-i18n-placeholder'));
    }
    var titles = document.querySelectorAll('[data-i18n-title]');
    for (var i = 0; i < titles.length; i++) {
        titles[i].title = t(titles[i].getAttribute('data-i18n-title'));
    }
    document.title = t('game_title');
    refreshEntityNames();
    refreshHeaderRows();
    refreshRequiredRowLabels();
    updateRebirthDescriptions();
    if (typeof updateStoryLogUI === 'function') updateStoryLogUI();
    if (typeof updateActiveEffectsUI === 'function') updateActiveEffectsUI();
    if (typeof updateCreditDisplay === 'function') updateCreditDisplay();
    if (typeof updateMilestoneIndicator === 'function') updateMilestoneIndicator();
}

function updateRebirthDescriptions() {
    var desc1 = document.getElementById('rebirthDesc1');
    if (desc1) {
        desc1.innerHTML = t('rebirth_amulet_3_desc_1') +
            '<b>' + t('rebirth_amulet_3_desc_xp') + '</b>' +
            t('rebirth_amulet_3_desc_2') +
            '<b>' + t('rebirth_amulet_3_desc_formula') + '</b>' +
            t('rebirth_amulet_3_desc_3') +
            '<span style="color: rgb(200, 0, 0)">' + t('rebirth_amulet_3_hint') + '</span>';
    }
    var desc2 = document.getElementById('rebirthDesc2');
    if (desc2) {
        var evilGain = (typeof getEvilGain === 'function') ? getEvilGain().toFixed(1) : '0';
        desc2.innerHTML = t('rebirth_amulet_4_desc') +
            '<b>' + evilGain + ' ' + t('evil_word') + '</b>' +
            t('rebirth_amulet_4_impact');
    }
}

function refreshEntityNames() {
    for (var name in gameData.taskData) {
        var row = document.getElementById('row ' + name);
        if (!row) continue;
        row.getElementsByClassName('name')[0].textContent = tName(name);
        var tt = row.getElementsByClassName('tooltipText');
        if (tt.length > 0) tt[0].textContent = tTooltip(name);
    }
    for (var name in gameData.itemData) {
        var row = document.getElementById('row ' + name);
        if (!row) continue;
        var n = row.getElementsByClassName('name');
        if (n.length > 0) n[0].textContent = tName(name);
        var tt = row.getElementsByClassName('tooltipText');
        if (tt.length > 0) tt[0].textContent = tTooltip(name);
    }
}

function refreshRequiredRowLabels() {
    var rows = document.getElementsByClassName('requiredRow');
    for (var i = 0; i < rows.length; i++) {
        var node = rows[i].firstChild;
        if (node && node.nodeType === 3) {
            node.textContent = t('required_word') + ' ';
        }
    }
}

function refreshHeaderRows() {
    if (typeof jobCategories === 'undefined') { console.warn('refreshHeaderRows: jobCategories not yet defined'); return; }
    var allCats = [jobCategories, skillCategories, itemCategories];
    for (var c = 0; c < allCats.length; c++) {
        for (var catName in allCats[c]) {
            var cn = catName.replace(/ /g, '');
            var els = document.getElementsByClassName(cn);
            for (var i = 0; i < els.length; i++) {
                if (els[i].classList.contains('headerRow')) {
                    var cat = els[i].getElementsByClassName('category');
                    if (cat.length > 0) cat[0].textContent = tCategory(catName);
                    var ths = els[i].getElementsByTagName('th');
                    if (allCats[c] !== itemCategories) {
                        if (ths[1]) ths[1].textContent = t('header_level');
                        var vt = els[i].getElementsByClassName('valueType');
                        if (vt.length > 0) vt[0].textContent = allCats[c] === jobCategories ? t('header_income_day') : t('header_effect');
                        if (ths[3]) ths[3].textContent = t('header_xp_day');
                        if (ths[4]) ths[4].textContent = t('header_xp_left');
                        if (ths[5]) ths[5].textContent = t('header_max_level');
                        if (ths[6]) ths[6].textContent = t('header_skip');
                    } else {
                        if (ths[1]) ths[1].textContent = t('header_active');
                        if (ths[2]) ths[2].textContent = t('header_effect');
                        if (ths[3]) ths[3].textContent = t('header_expense_day');
                    }
                }
            }
        }
    }
}
