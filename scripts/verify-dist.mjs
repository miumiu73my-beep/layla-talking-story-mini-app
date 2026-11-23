import {existsSync,readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
for(const path of ['dist/index.html','dist/app.json','dist/icon.jpg'])assert.ok(existsSync(path),path+' missing');
const html=readFileSync('dist/index.html','utf8');
assert.ok(html.includes('Talking Story'));
assert.ok(!/src="\/src\/main.js"/.test(html),'unbundled script');
const app=JSON.parse(readFileSync('dist/app.json','utf8'));
assert.equal(app.iconUri,'icon.jpg');console.log('Layla package verified');
