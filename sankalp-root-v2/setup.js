const webpush = require('web-push');
const fs = require('fs');

console.log('\n🌿 SANKALP 2026 — Setup\n');
const keys = webpush.generateVAPIDKeys();
console.log('VAPID Keys generated:\n');
console.log(`VAPID_PUBLIC_KEY=${keys.publicKey}`);
console.log(`VAPID_PRIVATE_KEY=${keys.privateKey}`);

const env = `VAPID_PUBLIC_KEY=${keys.publicKey}\nVAPID_PRIVATE_KEY=${keys.privateKey}\nANTHROPIC_API_KEY=your_key_here\nBASE_URL=http://localhost:3000\nPORT=3000\nADMIN_PIN=sankalp26\n`;
fs.writeFileSync('.env', env);
console.log('\n✅  Keys saved to .env');
console.log('   Add ANTHROPIC_API_KEY to .env to enable AI agent\n');
console.log('Next:');
console.log('  npm run qr   → generate QR codes');
console.log('  npm start    → start the server\n');
