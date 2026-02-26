const express = require('express');
const puppeteer = require('puppeteer');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3000;
const WORKER_API = 'https://scribd-viewer.akatwdao.workers.dev';

app.use(express.json());

// Extract doc ID from URL
function extractDocId(url) {
    const patterns = [
        /scribd\.com\/document\/(\d+)/i,
        /scribd\.com\/doc\/(\d+)/i,
        /scribd\.com\/embeds\/(\d+)/i
    ];
    
    for (const pattern of patterns) {
        const match = url.match(pattern);
        if (match) return match[1];
    }
    return null;
}

// Extract all pages using Puppeteer
async function extractPages(docId) {
    console.log(`Extracting doc: ${docId}`);
    
    const browser = await puppeteer.launch({
        headless: 'new',
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--disable-software-rasterizer'
        ]
    });
    
    try {
        const page = await browser.newPage();
        
        // Navigate to embed URL
        const embedUrl = `https://www.scribd.com/embeds/${docId}/content`;
        console.log(`Navigating to: ${embedUrl}`);
        
        await page.goto(embedUrl, { 
            waitUntil: 'networkidle2',
            timeout: 30000
        });
        
        // Wait for initial content
        await new Promise(r => setTimeout(r, 2000));
        
        // Scroll and collect pages
        const allPages = new Map();
        let scrollAttempts = 0;
        const maxScrolls = 100;
        
        while (scrollAttempts < maxScrolls) {
            // Extract images using JavaScript
            const pages = await page.evaluate(() => {
                const results = [];
                document.querySelectorAll('img').forEach(img => {
                    const match = img.src.match(/\/images\/(\d+)-([a-f0-9]+)\.png/i);
                    if (match) {
                        results.push({
                            page: parseInt(match[1]),
                            hash: match[2],
                            url: img.src.split('?')[0]
                        });
                    }
                });
                return results;
            });
            
            // Add to map (deduplication)
            for (const p of pages) {
                if (!allPages.has(p.page)) {
                    allPages.set(p.page, p);
                }
            }
            
            // Scroll down
            await page.evaluate(() => window.scrollBy(0, 600));
            scrollAttempts++;
            
            // Small delay
            await new Promise(r => setTimeout(r, 200));
            
            if (scrollAttempts % 20 === 0) {
                console.log(`Scroll ${scrollAttempts}, found ${allPages.size} pages`);
            }
        }
        
        // Get page info
        const info = await page.evaluate(() => {
            const text = document.body ? document.body.innerText : '';
            const match = text.match(/(\d+)\s*(?:pages?|slides?)/i);
            const title = document.title.replace(/\s*\|\s*Scribd\s*$/i, '').trim();
            const assetMatch = document.body ? document.body.innerHTML.match(/html\.scribdassets\.com\/([^\/\s]+)/) : null;
            return {
                pageCount: match ? parseInt(match[1]) : 0,
                title: title,
                assetId: assetMatch ? assetMatch[1] : null
            };
        });
        
        // Sort pages
        const pagesArray = Array.from(allPages.values()).sort((a, b) => a.page - b.page);
        
        console.log(`Extraction complete: ${pagesArray.length} pages found`);
        
        return {
            success: true,
            doc_id: docId,
            asset_id: info.assetId,
            title: info.title || 'Document',
            page_count: Math.max(info.pageCount, pagesArray.length),
            pages: pagesArray
        };
        
    } finally {
        await browser.close();
    }
}

// Save to D1 via Worker API
async function saveToD1(result) {
    try {
        const response = await fetch(`${WORKER_API}/api/cache`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(result)
        });
        return response.ok;
    } catch (e) {
        console.error('Failed to save to D1:', e.message);
        return false;
    }
}

// Health check
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        service: 'scribd-extractor',
        version: '1.0.0',
        engine: 'Node.js + Puppeteer'
    });
});

// GET extract endpoint
app.get('/extract', async (req, res) => {
    const url = req.query.url;
    if (!url) {
        return res.status(400).json({ error: 'missing_url', message: 'Please provide url parameter' });
    }
    
    const docId = extractDocId(url);
    if (!docId) {
        return res.status(400).json({ error: 'invalid_url', message: 'Could not extract document ID' });
    }
    
    try {
        const result = await extractPages(docId);
        res.json(result);
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// POST extract endpoint
app.post('/extract', async (req, res) => {
    const { url, save } = req.body;
    
    const docId = extractDocId(url);
    if (!docId) {
        return res.status(400).json({ success: false, error: 'invalid_url' });
    }
    
    try {
        const result = await extractPages(docId);
        
        // Save to D1 if requested
        if (save) {
            await saveToD1(result);
        }
        
        res.json(result);
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// Batch extract endpoint
app.post('/batch', async (req, res) => {
    const { urls } = req.body;
    const results = [];
    
    for (const url of urls || []) {
        const docId = extractDocId(url);
        if (!docId) {
            results.push({ url, success: false, error: 'invalid_url' });
            continue;
        }
        
        try {
            const result = await extractPages(docId);
            if (result.pages.length > 0) {
                await saveToD1(result);
            }
            results.push({ url, success: true, pages: result.pages.length });
        } catch (e) {
            results.push({ url, success: false, error: e.message });
        }
    }
    
    res.json({ success: true, results });
});

app.listen(PORT, () => {
    console.log(`🚀 Scribd Extractor running on port ${PORT}`);
    console.log(`📍 Health: http://localhost:${PORT}/health`);
    console.log(`📍 Extract: http://localhost:${PORT}/extract?url=<scribd_url>`);
});
