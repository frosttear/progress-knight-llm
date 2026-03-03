const express = require('express');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Parse JSON bodies
app.use(express.json());

// Serve static files
app.use(express.static(path.join(__dirname)));

// LLM proxy endpoint
app.post('/api/chat', async (req, res) => {
    const { messages, model, provider, ownApiKey } = req.body;

    // Determine API base URL and key based on provider
    const providers = {
        xai: {
            baseUrl: 'https://api.x.ai/v1/chat/completions',
            key: process.env.XAI_API_KEY,
            defaultModel: 'grok-3'
        },
        openai: {
            baseUrl: 'https://api.openai.com/v1/chat/completions',
            key: process.env.OPENAI_API_KEY,
            defaultModel: 'gpt-4o-mini'
        },
        deepseek: {
            baseUrl: 'https://api.deepseek.com/v1/chat/completions',
            key: process.env.DEEPSEEK_API_KEY,
            defaultModel: 'deepseek-chat'
        }
    };

    const selectedProvider = providers[provider] || providers.xai;
    // BYOK: prefer user-supplied key, fall back to server-side env key
    const apiKey = ownApiKey || selectedProvider.key;

    if (!apiKey) {
        return res.status(500).json({
            error: `API key not configured for provider: ${provider || 'xai'}. Set the corresponding env variable in .env or use your own key.`
        });
    }

    try {
        const response = await fetch(selectedProvider.baseUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
            },
            body: JSON.stringify({
                model: model || selectedProvider.defaultModel,
                messages: messages,
                temperature: 0.8,
                max_tokens: 1024
            })
        });

        if (!response.ok) {
            const errorText = await response.text();
            console.error(`LLM API error (${response.status}):`, errorText);
            return res.status(response.status).json({ error: errorText });
        }

        const data = await response.json();
        res.json(data);
    } catch (err) {
        console.error('Proxy error:', err);
        res.status(500).json({ error: err.message });
    }
});

// Get available providers (without exposing keys)
app.get('/api/providers', (req, res) => {
    const available = [];
    if (process.env.XAI_API_KEY) available.push({ id: 'xai', name: 'xAI (Grok)', defaultModel: 'grok-3' });
    if (process.env.OPENAI_API_KEY) available.push({ id: 'openai', name: 'OpenAI', defaultModel: 'gpt-4o-mini' });
    if (process.env.DEEPSEEK_API_KEY) available.push({ id: 'deepseek', name: 'DeepSeek', defaultModel: 'deepseek-chat' });
    res.json({ providers: available });
});

// Local dev only: expose env API key so the browser can call the LLM directly
app.get('/api/config', (req, res) => {
    const keys = {};
    if (process.env.XAI_API_KEY) keys.xai = process.env.XAI_API_KEY;
    if (process.env.OPENAI_API_KEY) keys.openai = process.env.OPENAI_API_KEY;
    if (process.env.DEEPSEEK_API_KEY) keys.deepseek = process.env.DEEPSEEK_API_KEY;
    // Pick the first available provider+key
    const provider = Object.keys(keys)[0] || null;
    res.json({ provider: provider, apiKey: keys[provider] || null, keys: keys });
});

app.listen(PORT, () => {
    console.log(`Progress Knight LLM server running at http://localhost:${PORT}`);
});
