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
            '--disable-software-rasterizer',
            '--disable-blink-features=AutomationControlled'
        ]
    });
    
    try {
        const page = await browser.newPage();
        
        // Stealth: Hide automation
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        await page.setViewport({ width: 1200, height: 900 });
        
        // Hide webdriver
        await page.evaluateOnNewDocument(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => false });
            window.chrome = { runtime: {} };
        });
        
        // Try document page first (more reliable)
        const docUrl = `https://www.scribd.com/document/${docId}`;
        console.log(`Navigating to: ${docUrl}`);
        
        const response = await page.goto(docUrl, { 
            waitUntil: 'domcontentloaded',
            timeout: 45000
        });
        
        console.log(`Response status: ${response.status()}`);
        
        // Wait for content
        await new Promise(r => setTimeout(r, 4000));
        
        // Check page content
        const initialCheck = await page.evaluate(() => {
            return {
                title: document.title,
                bodyText: document.body?.innerText?.substring(0, 500),
                images: document.querySelectorAll('img').length,
                scripts: document.querySelectorAll('script').length
            };
        });
        
        console.log('Initial check:', JSON.stringify(initialCheck));
        
        // Try to find the embed/viewer
        const embedUrl = await page.evaluate(() => {
            // Look for iframe or embed
            const iframe = document.querySelector('iframe[src*="embeds"]');
            if (iframe) return iframe.src;
            
            // Look for document viewer
            const viewer = document.querySelector('.document_viewer, .outer_page_container, #viewer');
            if (viewer) return window.location.href;
            
            return null;
        });
        
        if (embedUrl && embedUrl.includes('embeds')) {
            console.log(`Found embed URL: ${embedUrl}`);
            await page.goto(embedUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
            await new Promise(r => setTimeout(r, 3000));
        }
        
        // Scroll and collect pages
        const allPages = new Map();
        let scrollAttempts = 0;
        const maxScrolls = 150;
        
        while (scrollAttempts < maxScrolls) {
            // Extract images using JavaScript - try multiple patterns
            const pages = await page.evaluate(() => {
                const results = [];
                
                // Pattern 1: Standard image URL
                document.querySelectorAll('img').forEach(img => {
                    // Try multiple URL patterns
                    let match = img.src.match(/\/images\/(\d+)-([a-f0-9]+)\.png/i);
                    if (!match) {
                        match = img.src.match(/scribdassets\.com\/[^\/]+\/images\/(\d+)-([a-f0-9]+)/i);
                    }
                    if (!match && img.dataset && img.dataset.src) {
                        match = img.dataset.src.match(/\/images\/(\d+)-([a-f0-9]+)\.png/i);
                    }
                    
                    if (match) {
                        results.push({
                            page: parseInt(match[1]),
                            hash: match[2],
                            url: img.src.split('?')[0]
                        });
                    }
                });
                
                // Pattern 2: Background images
                document.querySelectorAll('[style*="background-image"]').forEach(el => {
                    const style = el.style.backgroundImage;
                    const match = style.match(/url\(['"]*([^'")]+\/images\/(\d+)-([a-f0-9]+)\.png[^'")]*)['"]*\)/i);
                    if (match) {
                        results.push({
                            page: parseInt(match[2]),
                            hash: match[3],
                            url: match[1].split('?')[0]
                        });
                    }
                });
                
                // Pattern 3: page_img class
                document.querySelectorAll('.page_img, .page_image, .absimg').forEach(img => {
                    const src = img.src || img.dataset.src || '';
                    const match = src.match(/\/(\d+)-([a-f0-9]+)\./);
                    if (match) {
                        results.push({
                            page: parseInt(match[1]),
                            hash: match[2],
                            url: src.split('?')[0]
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
            await page.evaluate(() => {
                window.scrollBy(0, 800);
            });
            scrollAttempts++;
            
            // Small delay
            await new Promise(r => setTimeout(r, 300));
            
            if (scrollAttempts % 30 === 0) {
                console.log(`Scroll ${scrollAttempts}, found ${allPages.size} pages`);
            }
        }
        
        // Get page info
        const info = await page.evaluate(() => {
            const text = document.body ? document.body.innerText : '';
            const html = document.body ? document.body.innerHTML : '';
            
            // Try multiple patterns for page count
            let pageCount = 0;
            const countPatterns = [
                /(\d+)\s*pages?/i,
                /total[_\s]*pages?[:\s]*(\d+)/i,
                /page[_\s]*count[:\s]*(\d+)/i,
                /"total_pages"\s*:\s*(\d+)/
            ];
            
            for (const pattern of countPatterns) {
                const match = text.match(pattern) || html.match(pattern);
                if (match) {
                    pageCount = parseInt(match[1]);
                    break;
                }
            }
            
            const title = document.title
                .replace(/\s*\|\s*Scribd\s*$/i, '')
                .replace(/\s*-\s*Scribd\s*$/i, '')
                .trim();
            
            const assetMatch = html.match(/html\.scribdassets\.com\/([^\/"'\s]+)/);
            
            return {
                pageCount,
                title,
                assetId: assetMatch ? assetMatch[1] : null
            };
        });
        
        // Sort pages
        const pagesArray = Array.from(allPages.values()).sort((a, b) => a.page - b.page);
        
        console.log(`Extraction complete: ${pagesArray.length} pages found, title: ${info.title}`);
        
        return {
            success: true,
            doc_id: docId,
            asset_id: info.assetId,
            title: info.title || 'Document',
            page_count: Math.max(info.pageCount, pagesArray.length),
            pages: pagesArray,
            debug: {
                initialTitle: initialCheck.title,
                imagesFound: initialCheck.images,
                scrollAttempts,
                embedUrl
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
        version: '1.1.0',
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
        if (save && result.success) {
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
            if (result.success && result.pages.length > 0) {
                await saveToD1(result);
            }
            results.push({ url, success: result.success, pages: result.pages?.length || 0 });
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
