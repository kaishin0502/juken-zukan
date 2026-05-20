#!/usr/bin/env node
// 受験図鑑サイト ヘルスチェックスクリプト
// 全画像URLの生存確認を行う

const https = require('https');

const SITE_URL = 'https://kaishin0502.github.io/juken-zukan';
const CONCURRENCY = 10;

function fetch(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 15000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const loc = res.headers.location.startsWith('http')
          ? res.headers.location
          : new URL(res.headers.location, url).href;
        res.resume();
        fetch(loc).then(resolve).catch(reject);
        return;
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, data }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

function headCheck(url) {
  return new Promise((resolve) => {
    const req = https.get(url, { timeout: 10000 }, (res) => {
      res.resume();
      resolve({ url: url.replace(SITE_URL + '/', ''), status: res.statusCode });
    });
    req.on('error', (err) => {
      resolve({ url: url.replace(SITE_URL + '/', ''), status: 0, error: err.message });
    });
    req.on('timeout', () => {
      req.destroy();
      resolve({ url: url.replace(SITE_URL + '/', ''), status: 0, error: 'Timeout' });
    });
  });
}

function extractSet(html, varName) {
  const re = new RegExp(`const ${varName}\\s*=\\s*new Set\\(\\[([\\s\\S]*?)\\]\\)`);
  const m = html.match(re);
  if (!m) return new Set();
  const items = new Set();
  const itemRe = /"([^"]+)"/g;
  let match;
  while ((match = itemRe.exec(m[1])) !== null) items.add(match[1]);
  return items;
}

function extractImgMap(html) {
  const m = html.match(/const IMG_MAP\s*=\s*\{([\s\S]*?)\};/);
  if (!m) return {};
  const map = {};
  const re = /"([^"]+)"\s*:\s*"([^"]+)"/g;
  let match;
  while ((match = re.exec(m[1])) !== null) map[match[1]] = match[2];
  return map;
}

async function checkBatch(urls) {
  const results = [];
  for (let i = 0; i < urls.length; i += CONCURRENCY) {
    const batch = urls.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.all(batch.map(headCheck));
    results.push(...batchResults);
  }
  return results;
}

async function main() {
  const startTime = Date.now();
  console.log(`🔍 受験図鑑 ヘルスチェック開始`);
  console.log(`   URL: ${SITE_URL}`);
  console.log(`   時刻: ${new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })}\n`);

  // 1. サイト読み込みチェック
  let html;
  try {
    const res = await fetch(SITE_URL + '/index.html');
    if (res.status !== 200) {
      console.error(`❌ サイトが応答しません (HTTP ${res.status})`);
      process.exit(1);
    }
    html = res.data;
    console.log('✅ サイト読み込み OK');
  } catch (err) {
    console.error(`❌ サイトに接続できません: ${err.message}`);
    process.exit(1);
  }

  // 2. データ構造を解析
  const imgMap = extractImgMap(html);
  const pngReady = extractSet(html, 'PNG_READY');
  const colorReady = extractSet(html, 'COLOR_READY');
  const svgReady = extractSet(html, 'SVG_READY');

  const filenames = new Set(Object.values(imgMap));
  console.log(`   アイテム数: ${filenames.size}`);
  console.log(`   PNG_READY: ${pngReady.size}, COLOR_READY: ${colorReady.size}, SVG_READY: ${svgReady.size}\n`);

  // 3. 画像URLリストを生成
  const urls = [];
  for (const file of filenames) {
    // カラー版
    if (colorReady.has(file)) {
      urls.push(`${SITE_URL}/img/color/${file}.png`);
    }
    // 白黒版
    if (pngReady.has(file)) {
      urls.push(`${SITE_URL}/img/${file}.png`);
    } else if (svgReady.has(file)) {
      urls.push(`${SITE_URL}/img/${file}.svg`);
    }
  }

  console.log(`🔍 画像チェック中... (${urls.length}枚)`);

  // 4. 全画像URLをチェック
  const results = await checkBatch(urls);
  const errors = results.filter(r => r.status !== 200);

  // 5. 結果表示
  console.log('');
  if (errors.length === 0) {
    console.log(`✅ 全${urls.length}枚の画像が正常に読み込めました！`);
  } else {
    console.log(`❌ ${errors.length}件のエラーが見つかりました：\n`);
    for (const err of errors) {
      const reason = err.error || `HTTP ${err.status}`;
      console.log(`   ❌ ${err.url} → ${reason}`);
    }
  }

  // 6. データ整合性チェック
  console.log('\n📋 データ整合性チェック:');
  let dataIssues = 0;

  // IMG_MAPにあるがPNG_READY/COLOR_READY/SVG_READYのいずれにもないファイル
  for (const file of filenames) {
    if (!pngReady.has(file) && !colorReady.has(file) && !svgReady.has(file)) {
      console.log(`   ⚠️ ${file}: IMG_MAPにあるがPNG/COLOR/SVG_READYに未登録`);
      dataIssues++;
    }
  }

  if (dataIssues === 0) {
    console.log('   ✅ データ整合性OK');
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n⏱️ チェック完了 (${elapsed}秒)`);

  // エラーがあったら終了コード1
  if (errors.length > 0 || dataIssues > 0) {
    // GitHub Actions用: エラー概要をまとめて出力
    const summary = [];
    if (errors.length > 0) summary.push(`画像エラー: ${errors.length}件`);
    if (dataIssues > 0) summary.push(`データ不整合: ${dataIssues}件`);
    console.log(`\n::error::${summary.join(', ')}`);
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
