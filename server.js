const express = require('express');
const puppeteer = require('puppeteer');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3000;

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
    console.log(`[START] Doc: ${docId}`);
    
    const browser = await puppeteer.launch({
        headless: 'new',
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu'
        ]
    });
    
    try {
        const page = await browser.newPage();
        
        await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36');
        await page.setViewport({ width: 1400, height: 900 });
        
        // Try the document page first (has more data)
        const docUrl = `https://www.scribd.com/document/${docId}`;
        console.log(`[NAV] ${docUrl}`);
        
        await page.goto(docUrl, { 
            waitUntil: 'domcontentloaded',
            timeout: 45000
        });
        
        await new Promise(r => setTimeout(r, 4000));
        
        // Get page data from document page
        let data = await page.evaluate(() => {
            const html = document.body.innerHTML;
            const assetMatch = html.match(/html\.scribdassets\.com\/([^\/"'\s]+)/);
            
            // Find pages in scripts
            const pages = [];
            const found = new Set();
            
            // Look for page data patterns
            const patterns = [
                /"(\d+)":\s*\{[^}]*"hash":\s*"([a-f0-9]{8,})"/g,
                /"page":\s*(\d+)[^}]*"hash":\s*"([a-f0-9]{8,})"/g,
                /\/images\/(\d+)-([a-f0-9]{8,})\./g
            ];
            
            document.querySelectorAll('script').forEach(script => {
                const content = script.textContent || '';
                for (const pattern of patterns) {
                    let m;
                    while ((m = pattern.exec(content)) !== null) {
                        const p = parseInt(m[1]);
                        if (!found.has(p) && m[2].length >= 8) {
                            found.add(p);
                            pages.push({ page: p, hash: m[2] });
                        }
                    }
                }
            });
            
            // Check __NEXT_DATA__
            const nextData = document.getElementById('__NEXT_DATA__');
            let pageCount = 0;
            if (nextData) {
                try {
                    const json = JSON.parse(nextData.textContent);
                    // Look for page count
                    const findCount = (obj) => {
                        if (obj && typeof obj === 'object') {
                            if (obj.total_pages) pageCount = obj.total_pages;
                            if (obj.page_count) pageCount = obj.page_count;
                            Object.values(obj).forEach(findCount);
                        }
                    };
                    findCount(json);
                } catch (e) {}
            }
            
            // Get title
            const title = document.title.replace(/\s*\|\s*Scribd\s*$/i, '').trim();
            
            return { assetId: assetMatch?.[1], pageCount, pages, title, foundInDoc: pages.length };
        });
        
        console.log(`[DOC] Found ${data.pages.length} pages in document page`);
        
        // If we didn't find enough pages, try embed URL
        if (data.pages.length < 5 && data.assetId) {
            console.log(`[EMBED] Trying embed URL...`);
            
            await page.goto(`https://www.scribd.com/embeds/${docId}/content`, {
                waitUntil: 'domcontentloaded',
                timeout: 30000
            });
            
            await new Promise(r => setTimeout(r, 3000));
            
            // Scroll
            for (let i = 0; i < 50; i++) {
                await page.evaluate(() => window.scrollBy(0, 500));
                await new Promise(r => setTimeout(r, 150));
            }
            
            await new Promise(r => setTimeout(r, 2000));
            
            // Extract from embed
            const embedData = await page.evaluate(() => {
                const pages = [];
                const found = new Set();
                
                // Images in HTML
                const imgPattern = /\/(\d+)-([a-f0-9]{8,})\./g;
                let m;
                while ((m = imgPattern.exec(document.body.innerHTML)) !== null) {
                    const p = parseInt(m[1]);
                    if (!found.has(p)) {
                        found.add(p);
                        pages.push({ page: p, hash: m[2] });
                    }
                }
                
                // img tags
                document.querySelectorAll('img').forEach(img => {
                    const src = img.src || '';
                    const match = src.match(/\/(\d+)-([a-f0-9]{8,})\./i);
                    if (match && !found.has(parseInt(match[1]))) {
                        found.add(parseInt(match[1]));
                        pages.push({ page: parseInt(match[1]), hash: match[2] });
                    }
                });
                
                // Page count
                const text = document.body.innerText;
                const countMatch = text.match(/(\d+)\s*pages?/i);
                
                return { pages, pageCount: countMatch ? parseInt(countMatch[1]) : 0 };
            });
            
            // Merge results
            const existingPages = new Set(data.pages.map(p => p.page));
            embedData.pages.forEach(p => {
                if (!existingPages.has(p.page)) {
                    data.pages.push(p);
                }
            });
            
            if (embedData.pageCount > data.pageCount) {
                data.pageCount = embedData.pageCount;
            }
            
            console.log(`[EMBED] Added ${embedData.pages.length} pages from embed`);
        }
        
        // Sort and dedupe
        const allPages = new Map();
        data.pages.forEach(p => {
            allPages.set(p.page, p);
        });
        
        const pagesArray = Array.from(allPages.values()).sort((a, b) => a.page - b.page);
        
        // Build URLs
        const pagesWithUrls = pagesArray.map(p => ({
            page: p.page,
            hash: p.hash,
            url: data.assetId ? 
                `https://html.scribdassets.com/${data.assetId}/images/${p.page}-${p.hash}.png` :
                null
        }));
        
        console.log(`[DONE] Total: ${pagesWithUrls.length} pages`);
        
        return {
            success: true,
            doc_id: docId,
            asset_id: data.assetId,
            title: data.title || 'Document',
            page_count: Math.max(data.pageCount, pagesWithUrls.length),
            pages: pagesWithUrls
        };
        
    } catch (e) {
        console.error(`[ERROR] ${e.message}`);
        return { success: false, doc_id: docId, error: e.message, pages: [] };
    } finally {
        await browser.close();
    }
}

app.get('/health', (req, res) => {
    res.json({ status: 'ok', version: '2.4.0' });
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

app.listen(PORT, () => console.log(`🚀 v2.4 on port ${PORT}`));
