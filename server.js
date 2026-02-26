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
        
        // Navigate to embed URL directly
        const embedUrl = `https://www.scribd.com/embeds/${docId}/content`;
        console.log(`Navigating to: ${embedUrl}`);
        
        const response = await page.goto(embedUrl, { 
            waitUntil: 'networkidle2',
            timeout: 60000
        });
        
        console.log(`Response status: ${response.status()}`);
        
        // Wait for content
        await new Promise(r => setTimeout(r, 5000));
        
        // Get all image URLs for debugging
        const imageDebug = await page.evaluate(() => {
            const images = [];
            document.querySelectorAll('img').forEach(img => {
                images.push({
                    src: img.src,
                    dataSrc: img.dataset?.src || null,
                    className: img.className
                });
            });
            
            // Also get page container info
            const pageContainers = document.querySelectorAll('.outer_page, .page_container, .page');
            const pageStyles = [];
            pageContainers.forEach((p, i) => {
                if (i < 3) {
                    pageStyles.push({
                        className: p.className,
                        style: p.style.backgroundImage || null,
                        innerHTML: p.innerHTML.substring(0, 200)
                    });
                }
            });
            
            return { images, pageStyles, bodyHTML: document.body.innerHTML.substring(0, 2000) };
        });
        
        console.log('Found images:', imageDebug.images.length);
        imageDebug.images.forEach((img, i) => {
            console.log(`Image ${i}: ${img.src}`);
        });
        
        // Extract all possible page patterns
        const allPages = new Map();
        
        // Pattern 1: Standard image URL with page number
        imageDebug.images.forEach(img => {
            if (img.src && img.src.includes('scribd')) {
                // Try to extract page number from various patterns
                let match = img.src.match(/\/(\d+)-([a-f0-9]{20,})\./);
                if (match) {
                    allPages.set(parseInt(match[1]), {
                        page: parseInt(match[1]),
                        hash: match[2],
                        url: img.src.split('?')[0]
                    });
                }
            }
        });
        
        // Pattern 2: From page styles
        imageDebug.pageStyles.forEach(style => {
            if (style.style) {
                const match = style.style.match(/url\(['"]*(\/[^'")]+)['"]*\)/);
                if (match) {
                    console.log('Found background image:', match[1]);
                }
            }
        });
        
        // Pattern 3: Look for asset_id in page and construct URLs
        const assetInfo = await page.evaluate(() => {
            const html = document.body.innerHTML;
            const assetMatch = html.match(/html\.scribdassets\.com\/([^\/"'\s]+)/);
            const scribdAssets = html.match(/scribdassets\.com[^"'\s]*/g);
            return {
                assetId: assetMatch ? assetMatch[1] : null,
                scribdUrls: scribdAssets ? scribdAssets.slice(0, 10) : []
            };
        });
        
        console.log('Asset info:', JSON.stringify(assetInfo));
        
        // Pattern 4: Extract from JSON data in page
        const jsonData = await page.evaluate(() => {
            const scripts = document.querySelectorAll('script');
            let docData = null;
            
            scripts.forEach(script => {
                const text = script.textContent || '';
                // Look for document page data
                if (text.includes('page') && text.includes('hash')) {
                    const pageMatch = text.match(/"pages"\s*:\s*\[([^\]]+)\]/);
                    if (pageMatch) {
                        docData = pageMatch[1];
                    }
                }
            });
            
            return docData;
        });
        
        console.log('JSON data found:', jsonData ? jsonData.substring(0, 200) : 'none');
        
        // Scroll and extract more
        let scrollAttempts = 0;
        const maxScrolls = 80;
        
        while (scrollAttempts < maxScrolls) {
            // Extract images
            const pages = await page.evaluate(() => {
                const results = [];
                
                // Check all images
                document.querySelectorAll('img').forEach(img => {
                    const src = img.src || img.dataset?.src || '';
                    if (src.includes('scribdassets') || src.includes('scribd')) {
                        // Various patterns
                        let match = src.match(/\/(\d+)-([a-f0-9]{16,})\./);
                        if (match) {
                            results.push({
                                page: parseInt(match[1]),
                                hash: match[2],
                                url: src.split('?')[0]
                            });
                        }
                    }
                });
                
                return results;
            });
            
            for (const p of pages) {
                if (!allPages.has(p.page)) {
                    allPages.set(p.page, p);
                }
            }
            
            await page.evaluate(() => window.scrollBy(0, 700));
            scrollAttempts++;
            await new Promise(r => setTimeout(r, 250));
        }
        
        // Get final page info
        const info = await page.evaluate(() => {
            const text = document.body.innerText;
            const match = text.match(/(\d+)\s*pages?/i);
            const title = document.title.replace(/\s*\|\s*Scribd\s*$/i, '').trim();
            
            return {
                pageCount: match ? parseInt(match[1]) : 0,
                title
            };
        });
        
        // Sort pages
        const pagesArray = Array.from(allPages.values()).sort((a, b) => a.page - b.page);
        
        console.log(`Extraction complete: ${pagesArray.length} pages found`);
        
        return {
            success: true,
            doc_id: docId,
            asset_id: assetInfo.assetId,
            title: info.title || 'Document',
            page_count: Math.max(info.pageCount, pagesArray.length),
            pages: pagesArray,
            debug: {
                imageCount: imageDebug.images.length,
                sampleImages: imageDebug.images.slice(0, 5).map(i => i.src),
                assetInfo: assetInfo,
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
        version: '1.2.0',
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
        if (save && result.success && result.pages.length > 0) {
            const response = await fetch(`${WORKER_API}/api/cache`, {
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
