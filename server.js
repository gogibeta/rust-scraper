const express = require('express');
const puppeteer = require('puppeteer');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3000;
const WORKER_API = 'https://scribd-viewer.akatwdao.workers.dev';

app.use(express.json());

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

async function extractPages(docId) {
    console.log(`Extracting doc: ${docId}`);
    
    const browser = await puppeteer.launch({
        headless: 'new',
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--disable-blink-features=AutomationControlled'
        ]
    });
    
    try {
        const page = await browser.newPage();
        
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36');
        await page.setViewport({ width: 1400, height: 1000 });
        
        await page.evaluateOnNewDocument(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => false });
            window.chrome = { runtime: {} };
        });
        
        // Go directly to embed URL
        const embedUrl = `https://www.scribd.com/embeds/${docId}/content`;
        console.log(`Navigating to: ${embedUrl}`);
        
        await page.goto(embedUrl, { 
            waitUntil: 'domcontentloaded',
            timeout: 45000
        });
        
        await new Promise(r => setTimeout(r, 4000));
        
        // Get page info
        const pageInfo = await page.evaluate(() => {
            const body = document.body;
            const html = body ? body.innerHTML : '';
            const text = body ? body.innerText : '';
            
            // Get all images
            const images = [];
            document.querySelectorAll('img').forEach(img => {
                const src = img.src || img.dataset?.src || '';
                if (src && !images.includes(src)) images.push(src);
            });
            
            // Get asset ID
            const assetMatch = html.match(/html\.scribdassets\.com\/([^\/"'\s]+)/);
            
            // Get page count
            const pageMatch = text.match(/(\d+)\s*(?:pages?|slides?)/i);
            
            return {
                title: document.title,
                images,
                imageCount: images.length,
                assetId: assetMatch ? assetMatch[1] : null,
                pageCount: pageMatch ? parseInt(pageMatch[1]) : 0,
                url: window.location.href,
                bodySample: text.substring(0, 300)
            };
        });
        
        console.log('Page info:', JSON.stringify(pageInfo));
        
        // Extract pages from image URLs
        const allPages = new Map();
        
        pageInfo.images.forEach(src => {
            // Pattern: /images/1-<hash>.png or /1-<hash>.png
            let match = src.match(/\/(\d+)-([a-f0-9]{16,})\./i);
            if (match) {
                allPages.set(parseInt(match[1]), {
                    page: parseInt(match[1]),
                    hash: match[2],
                    url: src.split('?')[0]
                });
            }
        });
        
        // Scroll to load more
        let scrollAttempts = 0;
        const maxScrolls = 80;
        
        while (scrollAttempts < maxScrolls) {
            const newPages = await page.evaluate(() => {
                const found = [];
                document.querySelectorAll('img').forEach(img => {
                    const src = img.src || img.dataset?.src || '';
                    const match = src.match(/\/(\d+)-([a-f0-9]{16,})\./i);
                    if (match) {
                        found.push({
                            page: parseInt(match[1]),
                            hash: match[2],
                            url: src.split('?')[0]
                        });
                    }
                });
                return found;
            });
            
            newPages.forEach(p => {
                if (!allPages.has(p.page)) {
                    allPages.set(p.page, p);
                }
            });
            
            await page.evaluate(() => window.scrollBy(0, 600));
            scrollAttempts++;
            await new Promise(r => setTimeout(r, 200));
        }
        
        const pagesArray = Array.from(allPages.values()).sort((a, b) => a.page - b.page);
        
        console.log(`Found ${pagesArray.length} pages`);
        
        return {
            success: true,
            doc_id: docId,
            asset_id: pageInfo.assetId,
            title: pageInfo.title.replace(/\s*\|\s*Scribd\s*$/i, '').trim(),
            page_count: Math.max(pageInfo.pageCount, pagesArray.length),
            pages: pagesArray,
            debug: {
                url: pageInfo.url,
                imageCount: pageInfo.imageCount,
                sampleImages: pageInfo.images.slice(0, 5),
                scrollAttempts
            }
        };
        
    } catch (e) {
        console.error(`Extraction failed: ${e.message}`);
        return {
            success: false,
            doc_id: docId,
            error: e.message,
            pages: []
        };
    } finally {
        await browser.close();
    }
}

app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        service: 'scribd-extractor',
        version: '1.5.0',
        engine: 'Node.js + Puppeteer'
    });
});

app.get('/extract', async (req, res) => {
    const url = req.query.url;
    if (!url) return res.status(400).json({ error: 'missing_url' });
    
    const docId = extractDocId(url);
    if (!docId) return res.status(400).json({ error: 'invalid_url' });
    
    try {
        const result = await extractPages(docId);
        res.json(result);
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.post('/extract', async (req, res) => {
    const { url, save } = req.body;
    const docId = extractDocId(url);
    if (!docId) return res.status(400).json({ success: false, error: 'invalid_url' });
    
    try {
        const result = await extractPages(docId);
        if (save && result.success && result.pages.length > 0) {
            await fetch(`${WORKER_API}/api/cache`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(result)
            });
        }
        res.json(result);
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.listen(PORT, () => console.log(`🚀 Scribd Extractor on port ${PORT}`));
