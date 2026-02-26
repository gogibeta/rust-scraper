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
            '--disable-blink-features=AutomationControlled'
        ]
    });
    
    try {
        const page = await browser.newPage();
        
        // Set realistic headers
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36');
        await page.setViewport({ width: 1400, height: 1000 });
        
        // Set extra headers
        await page.setExtraHTTPHeaders({
            'Accept-Language': 'en-US,en;q=0.9',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
            'Cache-Control': 'no-cache',
            'Pragma': 'no-cache'
        });
        
        // Hide webdriver
        await page.evaluateOnNewDocument(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => false });
            Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
            Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
            window.chrome = { runtime: {} };
            
            // Overwrite permissions
            const originalQuery = window.navigator.permissions.query;
            window.navigator.permissions.query = (parameters) => (
                parameters.name === 'notifications' ?
                    Promise.resolve({ state: Notification.permission }) :
                    originalQuery(parameters)
            );
        });
        
        // First visit scribd.com to get cookies
        console.log('Visiting scribd.com for cookies...');
        await page.goto('https://www.scribd.com/', { waitUntil: 'networkidle2', timeout: 30000 });
        await new Promise(r => setTimeout(r, 2000));
        
        // Get initial cookies
        const initialCookies = await page.cookies();
        console.log(`Got ${initialCookies.length} initial cookies`);
        
        // Now navigate to the document
        const docUrl = `https://www.scribd.com/document/${docId}`;
        console.log(`Navigating to: ${docUrl}`);
        
        const response = await page.goto(docUrl, { 
            waitUntil: 'networkidle2',
            timeout: 45000
        });
        
        console.log(`Response status: ${response.status()}`);
        
        // Wait for page to load
        await new Promise(r => setTimeout(r, 5000));
        
        // Check current URL and page content
        const currentUrl = page.url();
        console.log(`Current URL: ${currentUrl}`);
        
        // Check if we're on a login/paywall page
        const pageCheck = await page.evaluate(() => {
            const body = document.body;
            const html = body ? body.innerHTML : '';
            const text = body ? body.innerText : '';
            
            return {
                title: document.title,
                hasLogin: html.includes('login') || html.includes('sign in') || html.includes('Sign In'),
                hasPaywall: html.includes('subscribe') || html.includes('premium') || html.includes('upload'),
                hasDocument: html.includes('page') || html.includes('document') || html.includes('viewer'),
                imageCount: document.querySelectorAll('img').length,
                bodyTextSample: text.substring(0, 300)
            };
        });
        
        console.log('Page check:', JSON.stringify(pageCheck));
        
        // Check for "Read for free" button and click it
        try {
            const readFreeBtn = await page.$('a[href*="read"], button:has-text("Read"), .read_button, [data-testid="read-button"]');
            if (readFreeBtn) {
                console.log('Found read button, clicking...');
                await readFreeBtn.click();
                await new Promise(r => setTimeout(r, 3000));
            }
        } catch (e) {}
        
        // Try to find fullscreen view
        try {
            const fullscreenBtn = await page.$('[data-testid="fullscreen-button"], button[aria-label*="fullscreen"], .fullscreen_button');
            if (fullscreenBtn) {
                console.log('Clicking fullscreen...');
                await fullscreenBtn.click();
                await new Promise(r => setTimeout(r, 2000));
            }
        } catch (e) {}
        
        // Look for the document viewer or iframe
        const viewerInfo = await page.evaluate(() => {
            // Check for iframe
            const iframe = document.querySelector('iframe[src*="embeds"], iframe[src*="document"]');
            if (iframe) {
                return { type: 'iframe', src: iframe.src };
            }
            
            // Check for document viewer
            const viewer = document.querySelector('#viewer, .document_viewer, .outer_page_container');
            if (viewer) {
                return { type: 'viewer', found: true };
            }
            
            // Check for read page
            if (window.location.pathname.includes('/read/')) {
                return { type: 'read-page' };
            }
            
            return { type: 'unknown' };
        });
        
        console.log('Viewer info:', JSON.stringify(viewerInfo));
        
        // If iframe found, navigate to it
        if (viewerInfo.type === 'iframe' && viewerInfo.src) {
            console.log(`Navigating to iframe: ${viewerInfo.src}`);
            await page.goto(viewerInfo.src, { waitUntil: 'networkidle2', timeout: 30000 });
            await new Promise(r => setTimeout(r, 3000));
        }
        
        // Try the embed URL directly as fallback
        if (viewerInfo.type === 'unknown') {
            const embedUrl = `https://www.scribd.com/embeds/${docId}/content`;
            console.log(`Trying embed URL: ${embedUrl}`);
            await page.goto(embedUrl, { waitUntil: 'networkidle2', timeout: 30000 });
            await new Promise(r => setTimeout(r, 4000));
        }
        
        // Now extract pages
        const allPages = new Map();
        let scrollAttempts = 0;
        const maxScrolls = 100;
        
        while (scrollAttempts < maxScrolls) {
            const pageInfo = await page.evaluate(() => {
                const pages = [];
                const images = [];
                
                // Get all images
                document.querySelectorAll('img').forEach(img => {
                    const src = img.src || img.dataset?.src || '';
                    images.push(src);
                    
                    // Pattern: /images/1-<hash>.png or similar
                    const match = src.match(/\/(\d+)-([a-f0-9]{16,})\.(png|jpg|jpeg)/i);
                    if (match) {
                        pages.push({
                            page: parseInt(match[1]),
                            hash: match[2],
                            url: src.split('?')[0]
                        });
                    }
                });
                
                // Also check canvas elements (some pages use canvas)
                document.querySelectorAll('canvas').forEach(canvas => {
                    // Check if canvas has data
                    if (canvas.width > 100) {
                        images.push(`canvas:${canvas.width}x${canvas.height}`);
                    }
                });
                
                // Check for background images
                document.querySelectorAll('[style*="background-image"]').forEach(el => {
                    const style = el.getAttribute('style');
                    const match = style.match(/url\(['"]*([^'")]+)['"]*\)/);
                    if (match) {
                        images.push(match[1]);
                    }
                });
                
                // Get page count
                const bodyText = document.body?.innerText || '';
                const pageMatch = bodyText.match(/(\d+)\s*(?:pages?|slides?)/i);
                
                // Get asset ID
                const html = document.body?.innerHTML || '';
                const assetMatch = html.match(/html\.scribdassets\.com\/([^\/"'\s]+)/);
                
                return {
                    pages,
                    images: images.slice(0, 10),
                    pageCount: pageMatch ? parseInt(pageMatch[1]) : 0,
                    assetId: assetMatch ? assetMatch[1] : null,
                    title: document.title
                };
            });
            
            // Add found pages
            for (const p of pageInfo.pages) {
                if (!allPages.has(p.page)) {
                    allPages.set(p.page, p);
                }
            }
            
            // Log progress
            if (scrollAttempts === 0) {
                console.log(`Initial: ${pageInfo.images.length} images, ${allPages.size} pages`);
                console.log('Sample images:', pageInfo.images);
            }
            
            if (scrollAttempts % 20 === 0) {
                console.log(`Scroll ${scrollAttempts}, found ${allPages.size} pages`);
            }
            
            // Scroll
            await page.evaluate(() => {
                window.scrollBy(0, 700);
            });
            scrollAttempts++;
            await new Promise(r => setTimeout(r, 300));
        }
        
        // Get final info
        const finalInfo = await page.evaluate(() => {
            const text = document.body?.innerText || '';
            const pageMatch = text.match(/(\d+)\s*(?:pages?|slides?)/i);
            return {
                pageCount: pageMatch ? parseInt(pageMatch[1]) : 0,
                title: document.title.replace(/\s*\|\s*Scribd\s*$/i, '').trim()
            };
        });
        
        const pagesArray = Array.from(allPages.values()).sort((a, b) => a.page - b.page);
        
        console.log(`Extraction complete: ${pagesArray.length} pages found`);
        
        // Get final cookies for debugging
        const finalCookies = await page.cookies();
        
        return {
            success: true,
            doc_id: docId,
            asset_id: null,
            title: finalInfo.title || 'Document',
            page_count: Math.max(finalInfo.pageCount, pagesArray.length),
            pages: pagesArray,
            debug: {
                currentUrl,
                pageCheck,
                viewerInfo,
                cookiesCount: finalCookies.length,
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

// Health check
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        service: 'scribd-extractor',
        version: '1.3.0',
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

// POST extract endpoint with save option
app.post('/extract', async (req, res) => {
    const { url, save } = req.body;
    
    const docId = extractDocId(url);
    if (!docId) {
        return res.status(400).json({ success: false, error: 'invalid_url' });
    }
    
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

app.listen(PORT, () => {
    console.log(`🚀 Scribd Extractor running on port ${PORT}`);
});
