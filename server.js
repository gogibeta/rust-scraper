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
    console.log(`[START] Extracting doc: ${docId}`);
    
    const browser = await puppeteer.launch({
        headless: 'new',
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--disable-blink-features=AutomationControlled',
            '--disable-features=IsolateOrigins,site-per-process'
        ]
    });
    
    try {
        const page = await browser.newPage();
        
        await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36');
        await page.setViewport({ width: 1400, height: 1000 });
        
        await page.evaluateOnNewDocument(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => false });
            Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
            Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
            window.chrome = { runtime: {} };
        });
        
        // Try embed URL first (lighter weight)
        const embedUrl = `https://www.scribd.com/embeds/${docId}/content`;
        console.log(`[NAV] Going to: ${embedUrl}`);
        
        try {
            await page.goto(embedUrl, { 
                waitUntil: 'domcontentloaded',
                timeout: 30000
            });
            console.log(`[NAV] Embed loaded`);
        } catch (e) {
            console.log(`[NAV] Embed failed: ${e.message}`);
            // Try document page
            try {
                await page.goto(`https://www.scribd.com/document/${docId}`, { 
                    waitUntil: 'domcontentloaded',
                    timeout: 30000
                });
                console.log(`[NAV] Document page loaded`);
            } catch (e2) {
                throw new Error(`Failed to load page: ${e2.message}`);
            }
        }
        
        // Wait for initial content
        await new Promise(r => setTimeout(r, 3000));
        
        // Get page info and images
        const pageInfo = await page.evaluate(() => {
            const html = document.body.innerHTML;
            const text = document.body.innerText;
            
            // Get asset ID
            const assetMatch = html.match(/html\.scribdassets\.com\/([^\/"'\s]+)/);
            const assetId = assetMatch ? assetMatch[1] : null;
            
            // Get page count
            let pageCount = 0;
            const countPatterns = [
                /(\d+)\s*pages?/i,
                /"total_pages"\s*:\s*(\d+)/,
                /"page_count"\s*:\s*(\d+)/
            ];
            for (const p of countPatterns) {
                const m = text.match(p) || html.match(p);
                if (m) { pageCount = parseInt(m[1]); break; }
            }
            
            // Find all image URLs with page hashes
            const images = [];
            const imgPattern = /https?:\/\/html\.scribdassets\.com\/([^\/\s]+)\/images\/(\d+)-([a-f0-9]+)\.png/gi;
            let match;
            while ((match = imgPattern.exec(html)) !== null) {
                images.push({
                    assetId: match[1],
                    page: parseInt(match[2]),
                    hash: match[3],
                    url: match[0]
                });
            }
            
            // Also check img tags
            document.querySelectorAll('img').forEach(img => {
                const src = img.src || '';
                const m = src.match(/\/images\/(\d+)-([a-f0-9]+)\.png/i);
                if (m && !images.find(i => i.page === parseInt(m[1]))) {
                    images.push({
                        assetId: assetId,
                        page: parseInt(m[1]),
                        hash: m[2],
                        url: src.split('?')[0]
                    });
                }
            });
            
            return {
                title: document.title,
                assetId,
                pageCount,
                images,
                url: window.location.href
            };
        });
        
        console.log(`[INFO] Title: ${pageInfo.title}, Asset: ${pageInfo.assetId}, Pages: ${pageInfo.pageCount}, Images: ${pageInfo.images.length}`);
        
        // Collect all pages
        const allPages = new Map();
        pageInfo.images.forEach(img => {
            allPages.set(img.page, { page: img.page, hash: img.hash, url: img.url });
        });
        
        // If we have assetId but few pages, try to scroll and load more
        if (pageInfo.assetId && allPages.size < pageInfo.pageCount) {
            console.log(`[SCROLL] Starting scroll to load more pages...`);
            
            let scrollAttempts = 0;
            const maxScrolls = 100;
            
            while (scrollAttempts < maxScrolls && allPages.size < pageInfo.pageCount) {
                // Scroll down
                await page.evaluate(() => {
                    const scrollHeight = document.documentElement.scrollHeight;
                    const currentScroll = window.scrollY;
                    window.scrollTo(0, currentScroll + 600);
                });
                
                await new Promise(r => setTimeout(r, 400));
                
                // Check for new images
                const newImages = await page.evaluate(() => {
                    const found = [];
                    document.querySelectorAll('img').forEach(img => {
                        const src = img.src || '';
                        const match = src.match(/\/images\/(\d+)-([a-f0-9]+)\.png/i);
                        if (match) {
                            found.push({
                                page: parseInt(match[1]),
                                hash: match[2],
                                url: src.split('?')[0]
                            });
                        }
                    });
                    
                    // Also check background images
                    document.querySelectorAll('[style*="background"]').forEach(el => {
                        const style = el.getAttribute('style') || '';
                        const match = style.match(/url\(['"]*(\/[^'")]+\/images\/(\d+)-([a-f0-9]+)\.png)['"]*\)/i);
                        if (match) {
                            found.push({
                                page: parseInt(match[2]),
                                hash: match[3],
                                url: match[1]
                            });
                        }
                    });
                    
                    return found;
                });
                
                newImages.forEach(img => {
                    if (!allPages.has(img.page)) {
                        allPages.set(img.page, img);
                    }
                });
                
                scrollAttempts++;
                
                if (scrollAttempts % 20 === 0) {
                    console.log(`[SCROLL] Attempt ${scrollAttempts}, found ${allPages.size} pages`);
                }
            }
        }
        
        // If still no pages, try to get page data from scripts
        if (allPages.size === 0 && pageInfo.assetId) {
            console.log(`[SCRIPT] Looking for page data in scripts...`);
            
            const scriptData = await page.evaluate(() => {
                const results = [];
                document.querySelectorAll('script').forEach(script => {
                    const content = script.textContent || '';
                    // Look for page arrays
                    const pageMatches = content.matchAll(/"(\d+)":\s*\{[^}]*"hash":\s*"([a-f0-9]+)"/g);
                    for (const match of pageMatches) {
                        results.push({ page: parseInt(match[1]), hash: match[2] });
                    }
                });
                return results;
            });
            
            scriptData.forEach(p => {
                if (!allPages.has(p.page)) {
                    allPages.set(p.page, {
                        page: p.page,
                        hash: p.hash,
                        url: `https://html.scribdassets.com/${pageInfo.assetId}/images/${p.page}-${p.hash}.png`
                    });
                }
            });
        }
        
        const pagesArray = Array.from(allPages.values()).sort((a, b) => a.page - b.page);
        
        console.log(`[DONE] Found ${pagesArray.length} pages`);
        
        // If we have asset ID but no pages found, construct at least page 1
        if (pagesArray.length === 0 && pageInfo.assetId) {
            // Return just the asset info so user can try manually
            return {
                success: false,
                doc_id: docId,
                asset_id: pageInfo.assetId,
                title: pageInfo.title.replace(/\s*\|\s*Scribd\s*$/i, '').trim(),
                page_count: pageInfo.pageCount,
                pages: [],
                error: 'Could not extract pages. Document may require login or is protected.',
                debug: { assetId: pageInfo.assetId, pageCount: pageInfo.pageCount }
            };
        }
        
        return {
            success: true,
            doc_id: docId,
            asset_id: pageInfo.assetId,
            title: pageInfo.title.replace(/\s*\|\s*Scribd\s*$/i, '').trim(),
            page_count: Math.max(pageInfo.pageCount, pagesArray.length),
            pages: pagesArray
        };
        
    } catch (e) {
        console.error(`[ERROR] ${e.message}`);
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
        version: '2.1.0',
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

app.listen(PORT, () => console.log(`🚀 Scribd Extractor v2.1 on port ${PORT}`));
