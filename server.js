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
            '--disable-blink-features=AutomationControlled'
        ]
    });
    
    try {
        const page = await browser.newPage();
        
        await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36');
        await page.setViewport({ width: 1400, height: 1000 });
        
        await page.evaluateOnNewDocument(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => false });
            window.chrome = { runtime: {} };
        });
        
        // Go to embed URL
        const embedUrl = `https://www.scribd.com/embeds/${docId}/content`;
        console.log(`[NAV] Going to: ${embedUrl}`);
        
        await page.goto(embedUrl, { 
            waitUntil: 'networkidle2',
            timeout: 45000
        });
        
        console.log(`[NAV] Page loaded`);
        
        // Wait for content
        await new Promise(r => setTimeout(r, 5000));
        
        // Scroll to bottom to trigger all lazy loading
        console.log(`[SCROLL] Scrolling to load all pages...`);
        
        for (let i = 0; i < 100; i++) {
            await page.evaluate(() => {
                window.scrollBy(0, 700);
            });
            await new Promise(r => setTimeout(r, 200));
        }
        
        // Wait after scrolling
        await new Promise(r => setTimeout(r, 3000));
        
        // Extract ALL page hashes from the page
        const pageData = await page.evaluate(() => {
            const html = document.body.innerHTML;
            const text = document.body.innerText;
            
            // Get asset ID
            const assetMatch = html.match(/html\.scribdassets\.com\/([^\/"'\s]+)/);
            const assetId = assetMatch ? assetMatch[1] : null;
            
            // Get page count
            let pageCount = 0;
            const countMatch = text.match(/(\d+)\s*pages?/i) || html.match(/"total_pages"\s*:\s*(\d+)/);
            if (countMatch) pageCount = parseInt(countMatch[1]);
            
            // Collect all page hashes
            const pages = [];
            const foundPages = new Set();
            
            // Method 1: Direct image URLs
            const imgPattern = /\/(\d+)-([a-f0-9]{8,})\.(png|jpg)/gi;
            let match;
            while ((match = imgPattern.exec(html)) !== null) {
                const pageNum = parseInt(match[1]);
                if (!foundPages.has(pageNum)) {
                    foundPages.add(pageNum);
                    pages.push({ page: pageNum, hash: match[2] });
                }
            }
            
            // Method 2: Full URLs
            const urlPattern = /https?:\/\/[^"'\s]+\/images\/(\d+)-([a-f0-9]{8,})\./gi;
            while ((match = urlPattern.exec(html)) !== null) {
                const pageNum = parseInt(match[1]);
                if (!foundPages.has(pageNum)) {
                    foundPages.add(pageNum);
                    pages.push({ page: pageNum, hash: match[2] });
                }
            }
            
            // Method 3: img tags
            document.querySelectorAll('img').forEach(img => {
                const src = img.src || img.dataset?.src || '';
                const m = src.match(/\/(\d+)-([a-f0-9]{8,})\./i);
                if (m && !foundPages.has(parseInt(m[1]))) {
                    foundPages.add(parseInt(m[1]));
                    pages.push({ page: parseInt(m[1]), hash: m[2] });
                }
            });
            
            // Method 4: Look for page data in ALL script content
            const scripts = document.querySelectorAll('script');
            scripts.forEach(script => {
                const content = script.textContent || '';
                
                // Various patterns for page hashes
                const patterns = [
                    /"(\d+)":\s*\{[^}]*"hash":\s*"([a-f0-9]{8,})"/gi,
                    /"page":\s*(\d+)[^}]*"hash":\s*"([a-f0-9]{8,})"/gi,
                    /\\"page\\":\s*(\d+)[^}]*\\"hash\\":\s*\\"([a-f0-9]{8,})/gi,
                    /images\/(\d+)-([a-f0-9]{8,})\./gi
                ];
                
                for (const pattern of patterns) {
                    let m;
                    while ((m = pattern.exec(content)) !== null) {
                        const pageNum = parseInt(m[1]);
                        if (!foundPages.has(pageNum)) {
                            foundPages.add(pageNum);
                            pages.push({ page: pageNum, hash: m[2] });
                        }
                    }
                }
            });
            
            // Method 5: Check for page_urls in window
            try {
                // Look for __NEXT_DATA__ or similar
                const nextData = document.getElementById('__NEXT_DATA__');
                if (nextData) {
                    const data = JSON.parse(nextData.textContent);
                    const findPages = (obj) => {
                        if (obj && typeof obj === 'object') {
                            if (obj.page !== undefined && obj.hash) {
                                const pageNum = parseInt(obj.page);
                                if (!foundPages.has(pageNum)) {
                                    foundPages.add(pageNum);
                                    pages.push({ page: pageNum, hash: obj.hash });
                                }
                            }
                            Object.values(obj).forEach(findPages);
                        }
                        if (Array.isArray(obj)) {
                            obj.forEach(findPages);
                        }
                    };
                    findPages(data);
                }
            } catch (e) {}
            
            // Method 6: Extract from background images
            document.querySelectorAll('[style*="background"]').forEach(el => {
                const style = el.getAttribute('style') || '';
                const m = style.match(/url\([^)]*(\d+)-([a-f0-9]{8,})\.[^)]*\)/i);
                if (m && !foundPages.has(parseInt(m[1]))) {
                    foundPages.add(parseInt(m[1]));
                    pages.push({ page: parseInt(m[1]), hash: m[2] });
                }
            });
            
            return {
                title: document.title,
                assetId,
                pageCount,
                pages,
                debug: {
                    htmlLength: html.length,
                    scriptCount: scripts.length,
                    imageCount: document.querySelectorAll('img').length,
                    foundPages: pages.length
                }
            };
        });
        
        console.log(`[DATA] Found ${pageData.pages.length} pages, asset: ${pageData.assetId}, total: ${pageData.pageCount}`);
        console.log(`[DEBUG] HTML: ${pageData.debug.htmlLength}, Scripts: ${pageData.debug.scriptCount}, Images: ${pageData.debug.imageCount}`);
        
        // Build page objects
        const allPages = new Map();
        if (pageData.assetId) {
            pageData.pages.forEach(p => {
                allPages.set(p.page, {
                    page: p.page,
                    hash: p.hash,
                    url: `https://html.scribdassets.com/${pageData.assetId}/images/${p.page}-${p.hash}.png`
                });
            });
        }
        
        const pagesArray = Array.from(allPages.values()).sort((a, b) => a.page - b.page);
        
        console.log(`[DONE] Total pages found: ${pagesArray.length}`);
        
        return {
            success: true,
            doc_id: docId,
            asset_id: pageData.assetId,
            title: pageData.title.replace(/\s*\|\s*Scribd\s*$/i, '').trim(),
            page_count: Math.max(pageData.pageCount, pagesArray.length),
            pages: pagesArray,
            debug: pageData.debug
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
        version: '2.3.0',
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

app.listen(PORT, () => console.log(`🚀 Scribd Extractor v2.3 on port ${PORT}`));
