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
        await page.setViewport({ width: 1200, height: 900 });
        
        await page.evaluateOnNewDocument(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => false });
            window.chrome = { runtime: {} };
        });
        
        // Go to document page (not embed) - it loads more content
        const docUrl = `https://www.scribd.com/document/${docId}`;
        console.log(`Navigating to: ${docUrl}`);
        
        await page.goto(docUrl, { 
            waitUntil: 'networkidle2',
            timeout: 60000
        });
        
        // Wait for content to load
        await new Promise(r => setTimeout(r, 5000));
        
        // Try to click "Read for free" if present
        try {
            const readBtn = await page.$('[data-testid="read-button"], .read_btn, a[href*="read"]');
            if (readBtn) {
                console.log('Clicking read button...');
                await readBtn.click();
                await new Promise(r => setTimeout(r, 3000));
            }
        } catch (e) {}
        
        // Try clicking fullscreen
        try {
            const fsBtn = await page.$('[aria-label*="fullscreen"], [data-testid="fullscreen"]');
            if (fsBtn) {
                await fsBtn.click();
                await new Promise(r => setTimeout(r, 2000));
            }
        } catch (e) {}
        
        // Get initial page info
        const pageInfo = await page.evaluate(() => {
            const html = document.body.innerHTML;
            const text = document.body.innerText;
            
            // Get asset ID
            const assetMatch = html.match(/html\.scribdassets\.com\/([^\/"'\s]+)/);
            
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
            
            // Find all page image URLs
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
            
            // Also check for page data in scripts
            const scripts = document.querySelectorAll('script');
            let pageData = null;
            scripts.forEach(script => {
                const content = script.textContent || '';
                // Look for page data arrays
                if (content.includes('page') && content.includes('hash')) {
                    const pagesMatch = content.match(/"pages"\s*:\s*\[([^\]]+)\]/);
                    if (pagesMatch) {
                        pageData = pagesMatch[1];
                    }
                }
            });
            
            return {
                title: document.title,
                assetId: assetMatch ? assetMatch[1] : null,
                pageCount,
                images,
                pageData,
                url: window.location.href
            };
        });
        
        console.log('Page info:', JSON.stringify({ 
            title: pageInfo.title, 
            assetId: pageInfo.assetId, 
            pageCount: pageInfo.pageCount,
            imageCount: pageInfo.images.length,
            url: pageInfo.url
        }));
        
        // Collect all pages
        const allPages = new Map();
        
        // Add found images
        pageInfo.images.forEach(img => {
            allPages.set(img.page, {
                page: img.page,
                hash: img.hash,
                url: img.url
            });
        });
        
        // Scroll to trigger lazy loading
        console.log('Scrolling to load more pages...');
        let scrollAttempts = 0;
        const maxScrolls = 150;
        let noNewPagesCount = 0;
        
        while (scrollAttempts < maxScrolls) {
            // Scroll down
            await page.evaluate(() => {
                window.scrollBy(0, 500);
            });
            
            await new Promise(r => setTimeout(r, 300));
            
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
                return found;
            });
            
            const prevSize = allPages.size;
            newImages.forEach(img => {
                if (!allPages.has(img.page)) {
                    allPages.set(img.page, img);
                }
            });
            
            // If no new pages for 20 scrolls, try scrolling up and down
            if (allPages.size === prevSize) {
                noNewPagesCount++;
                if (noNewPagesCount > 20) {
                    // Try scrolling to top then down again
                    await page.evaluate(() => window.scrollTo(0, 0));
                    await new Promise(r => setTimeout(r, 500));
                    await page.evaluate(() => window.scrollBy(0, 1000));
                    noNewPagesCount = 0;
                }
            } else {
                noNewPagesCount = 0;
            }
            
            scrollAttempts++;
            
            if (scrollAttempts % 30 === 0) {
                console.log(`Scroll ${scrollAttempts}, found ${allPages.size} pages`);
            }
            
            // Stop if we found all expected pages
            if (pageInfo.pageCount > 0 && allPages.size >= pageInfo.pageCount) {
                console.log(`Found all ${allPages.size} pages!`);
                break;
            }
        }
        
        // Try to get more pages from page source
        const morePages = await page.evaluate(() => {
            const pages = [];
            const html = document.body.innerHTML;
            
            // Look for page patterns in HTML
            const pattern = /\/images\/(\d+)-([a-f0-9]+)\.png/gi;
            let match;
            while ((match = pattern.exec(html)) !== null) {
                pages.push({
                    page: parseInt(match[1]),
                    hash: match[2]
                });
            }
            
            return pages;
        });
        
        morePages.forEach(p => {
            if (!allPages.has(p.page) && pageInfo.assetId) {
                allPages.set(p.page, {
                    page: p.page,
                    hash: p.hash,
                    url: `https://html.scribdassets.com/${pageInfo.assetId}/images/${p.page}-${p.hash}.png`
                });
            }
        });
        
        const pagesArray = Array.from(allPages.values()).sort((a, b) => a.page - b.page);
        
        console.log(`Extraction complete: ${pagesArray.length} pages found`);
        
        return {
            success: true,
            doc_id: docId,
            asset_id: pageInfo.assetId,
            title: pageInfo.title.replace(/\s*\|\s*Scribd\s*$/i, '').trim(),
            page_count: Math.max(pageInfo.pageCount, pagesArray.length),
            pages: pagesArray
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
        version: '2.0.0',
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

app.listen(PORT, () => console.log(`🚀 Scribd Extractor v2.0 on port ${PORT}`));
