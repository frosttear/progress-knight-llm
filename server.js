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
    // BYOK only — never use server-side env keys
    const apiKey = ownApiKey;

    if (!apiKey) {
        return res.status(401).json({
            error: 'No API key provided. Please enter your own API key in the settings (BYOK).'
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

// Get available providers
app.get('/api/providers', (req, res) => {
    res.json({ providers: [
        { id: 'xai',      name: 'xAI (Grok)', defaultModel: 'grok-3' },
        { id: 'openai',   name: 'OpenAI',     defaultModel: 'gpt-4o-mini' },
        { id: 'deepseek', name: 'DeepSeek',   defaultModel: 'deepseek-chat' }
    ]});
});

app.listen(PORT, () => {
    console.log(`Progress Knight LLM server running at http://localhost:${PORT}`);
});
