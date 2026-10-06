// Récupère les binaires Windows (non installables sur Linux par npm) avant la compilation de l'installeur.
// Usage : node scripts/fetch-win-natives.js
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const root = path.join(__dirname, '..');
const pkg = require(path.join(root, 'package.json'));
const ver = (name) => (pkg.dependencies[name] || '').replace(/^[\^~]/, '');
const natives = [
  ['sherpa-onnx-win-x64', ver('sherpa-onnx-node')],
  ['@node-llama-cpp/win-x64', ver('node-llama-cpp')],
  ['@node-llama-cpp/win-x64-vulkan', ver('node-llama-cpp')],
];
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vf-natives-'));
for (const [name, v] of natives) {
  const dest = path.join(root, 'node_modules', name);
  const pj = path.join(dest, 'package.json');
  if (fs.existsSync(pj) && JSON.parse(fs.readFileSync(pj, 'utf8')).version === v) { console.log('ok      ', name, v); continue; }
  console.log('fetch   ', name, v);
  const file = execSync(`npm pack ${name}@${v} --silent`, { cwd: tmp }).toString().trim().split('\n').pop();
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  execSync(`tar -xzf "${path.join(tmp, file)}" -C "${dest}" --strip-components=1`);
}
fs.rmSync(tmp, { recursive: true, force: true });
