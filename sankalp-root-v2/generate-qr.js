require('dotenv').config();
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');

const attendees = JSON.parse(fs.readFileSync('./data/attendees.json'));
const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const OUT_DIR = path.join(__dirname, 'qr-codes');

if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR);

(async () => {
  console.log('\n🌿 SANKALP — Generating QR Codes\n');
  for (const a of attendees) {
    const url = `${BASE_URL}/a/${a.id}`;
    const file = path.join(OUT_DIR, `${a.name}_${a.id}.png`);
    await QRCode.toFile(file, url, {
      width: 400, margin: 2,
      color: { dark: '#0E0F09', light: '#F5F2E8' }
    });
    console.log(`  ✅  ${a.name.padEnd(12)} → ${url}`);
  }
  const summary = attendees.map(a => ({
    name: a.name, id: a.id, group: a.groupLabel,
    url: `${BASE_URL}/a/${a.id}`, qrFile: `${a.name}_${a.id}.png`
  }));
  fs.writeFileSync(path.join(OUT_DIR, '_summary.json'), JSON.stringify(summary, null, 2));
  console.log(`\n📁 Saved to: ${OUT_DIR}\n`);
})();
