const puppeteer = require('puppeteer-core');
const path = require('path');
const fs = require('fs');

const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const outDir = 'C:\\Users\\suban\\.gemini\\antigravity\\brain\\059e23fb-2bcd-4081-8fba-77c01550b57b';

async function capture() {
    console.log('[SCREENSHOT] Launching Chrome...');
    const browser = await puppeteer.launch({
        executablePath: chromePath,
        headless: true,
        userDataDir: 'C:\\Users\\suban\\AppData\\Local\\Temp\\chrome_capture_data',
        defaultViewport: { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-web-security']
    });

    try {
        const page = await browser.newPage();

        // 1. Screen 1: Customer Pay in Cash Selector
        console.log('[1/4] Loading https://api.redrivo.in/customer/#preview-hire-driver ...');
        await page.goto('https://api.redrivo.in/customer/#preview-hire-driver', { waitUntil: 'networkidle2', timeout: 30000 });
        await new Promise(r => setTimeout(r, 2000));
        await page.screenshot({ path: path.join(outDir, 'screen1_customer_cash.png') });
        console.log('  -> Saved screen1_customer_cash.png');

        // 2. Screen 2: Driver Incoming Cash Request (Real established screen)
        console.log('[2/4] Loading https://drivers.redrivo.in/#preview-incoming-cash ...');
        await page.goto('https://drivers.redrivo.in/#preview-incoming-cash', { waitUntil: 'networkidle2', timeout: 30000 });
        await new Promise(r => setTimeout(r, 3500));
        await page.screenshot({ path: path.join(outDir, 'screen2_driver_incoming_cash.png') });
        console.log('  -> Saved screen2_driver_incoming_cash.png');

        // 3. Screen 3: Driver Wallet Outstanding Balance
        console.log('[3/4] Loading https://drivers.redrivo.in/#preview-driver-wallet ...');
        await page.goto('https://drivers.redrivo.in/#preview-driver-wallet', { waitUntil: 'networkidle2', timeout: 30000 });
        await new Promise(r => setTimeout(r, 2000));
        await page.screenshot({ path: path.join(outDir, 'screen3_driver_wallet.png') });
        console.log('  -> Saved screen3_driver_wallet.png');

        // 4. Screen 4: Driver Blocked Screen
        console.log('[4/4] Loading https://drivers.redrivo.in/#preview-wallet-blocked ...');
        await page.goto('https://drivers.redrivo.in/#preview-wallet-blocked', { waitUntil: 'networkidle2', timeout: 30000 });
        await new Promise(r => setTimeout(r, 2000));
        await page.screenshot({ path: path.join(outDir, 'screen4_driver_blocked.png') });
        console.log('  -> Saved screen4_driver_blocked.png');

        console.log('[SUCCESS] All 4 live screenshots captured successfully!');
    } catch (err) {
        console.error('[ERROR]', err);
    } finally {
        await browser.close();
    }
}

capture();
