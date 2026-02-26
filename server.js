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
        
        // Extract ALL data from page
        const pageData = await page.evaluate(() => {
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
            
            // Find ALL page hashes - try multiple methods
            const pages = [];
            const foundHashes = new Set();
            
            // Method 1: Image URLs in HTML
            const imgPattern = /\/images\/(\d+)-([a-f0-9]+)\.png/gi;
            let match;
            while ((match = imgPattern.exec(html)) !== null) {
                const pageNum = parseInt(match[1]);
                if (!foundHashes.has(pageNum)) {
                    foundHashes.add(pageNum);
                    pages.push({ page: pageNum, hash: match[2] });
                }
            }
            
            // Method 2: Look in img tags
            document.querySelectorAll('img').forEach(img => {
                const src = img.src || img.dataset?.src || '';
                const m = src.match(/\/images\/(\d+)-([a-f0-9]+)\./i);
                if (m && !foundHashes.has(parseInt(m[1]))) {
                    foundHashes.add(parseInt(m[1]));
                    pages.push({ page: parseInt(m[1]), hash: m[2] });
                }
            });
            
            // Method 3: Look for page data in JavaScript objects
            // Scribd stores page data in various places
            const scripts = document.querySelectorAll('script');
            scripts.forEach(script => {
                const content = script.textContent || '';
                
                // Pattern: "1":{"hash":"xxx"} or page: {hash: "xxx"}
                const hashPatterns = [
                    /"(\d+)":\s*\{[^}]*"hash":\s*"([a-f0-9]+)"/g,
                    /"pages"\s*:\s*\{[^}]*"(\d+)":\s*\{[^}]*"hash":\s*"([a-f0-9]+)"/g,
                    /\\"page\\":\s*(\d+),\s*\\"hash\\":\s*\\"([a-f0-9]+)\\"/g
                ];
                
                for (const pattern of hashPatterns) {
                    let m;
                    while ((m = pattern.exec(content)) !== null) {
                        const pageNum = parseInt(m[1]);
                        if (!foundHashes.has(pageNum) && m[2].length >= 8) {
                            foundHashes.add(pageNum);
                            pages.push({ page: pageNum, hash: m[2] });
                        }
                    }
                }
            });
            
            // Method 4: Check window object for page data
            if (window.__INITIAL_STATE__ || window.__PRELOADED_STATE__ || window.pageData) {
                const state = window.__INITIAL_STATE__ || window.__PRELOADED_STATE__ || window.pageData;
                if (state && state.pages) {
                    Object.keys(state.pages).forEach(key => {
                        const p = state.pages[key];
                        if (p.hash && !foundHashes.has(parseInt(key))) {
                            foundHashes.add(parseInt(key));
                            pages.push({ page: parseInt(key), hash: p.hash });
                        }
                    });
                }
            }
            
            // Method 5: Look for JSON in data attributes
            document.querySelectorAll('[data-pages], [data-page-data]').forEach(el => {
                try {
                    const data = JSON.parse(el.dataset.pages || el.dataset.pageData || '{}');
                    Object.keys(data).forEach(key => {
                        const p = data[key];
                        if (p.hash && !foundHashes.has(parseInt(key))) {
                            foundHashes.add(parseInt(key));
                            pages.push({ page: parseInt(key), hash: p.hash });
                        }
                    });
                } catch (e) {}
            });
            
            return {
                title: document.title,
                assetId,
                pageCount,
                pages,
                debug: {
                    htmlLength: html.length,
                    scriptCount: scripts.length,
                    imageCount: document.querySelectorAll('img').length
                }
            };
        });
        
        console.log(`[DATA] Found ${pageData.pages.length} pages, asset: ${pageData.assetId}, total: ${pageData.pageCount}`);
        console.log(`[DEBUG] HTML length: ${pageData.debug.htmlLength}, scripts: ${pageData.debug.scriptCount}`);
        
        // If we found pages, construct URLs
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
        
        // If we still don't have enough pages, try scrolling
        if (allPages.size < pageData.pageCount && pageData.assetId) {
            console.log(`[SCROLL] Attempting to load more pages...`);
            
            let scrollAttempts = 0;
            const maxScrolls = 80;
            
            while (scrollAttempts < maxScrolls && allPages.size < pageData.pageCount) {
                await page.evaluate(() => {
                    window.scrollBy(0, 600);
                });
                
                await new Promise(r => setTimeout(r, 300));
                
                // Check for new images
                const newImages = await page.evaluate(() => {
                    const found = [];
                    document.querySelectorAll('img').forEach(img => {
                        const src = img.src || '';
                        const m = src.match(/\/images\/(\d+)-([a-f0-9]+)\./i);
                        if (m) {
                            found.push({ page: parseInt(m[1]), hash: m[2] });
                        }
                    });
                    return found;
                });
                
                newImages.forEach(p => {
                    if (!allPages.has(p.page)) {
                        allPages.set(p.page, {
                            page: p.page,
                            hash: p.hash,
                            url: `https://html.scribdassets.com/${pageData.assetId}/images/${p.page}-${p.hash}.png`
                        });
                    }
                });
                
                scrollAttempts++;
            }
            
            console.log(`[SCROLL] Found ${allPages.size} pages after scrolling`);
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
        version: '2.2.0',
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

app.listen(PORT, () => console.log(`🚀 Scribd Extractor v2.2 on port ${PORT}`));
