'use strict';
// Appelé par electron-builder (afterPack) : verrouille l'exécutable Electron
// pour qu'on ne puisse pas le détourner (lancer du Node arbitraire, injecter du code, modifier app.asar).

const path = require('path');
const fs = require('fs');
const { flipFuses, FuseVersion, FuseV1Options } = require('@electron/fuses');

module.exports = async function appliquerFuses(context) {
  const { appOutDir, electronPlatformName, packager } = context;
  const nom = packager.appInfo.productFilename;
  const executable = {
    win32: path.join(appOutDir, `${nom}.exe`),
    linux: path.join(appOutDir, packager.executableName || nom.toLowerCase()),
    darwin: path.join(appOutDir, `${nom}.app`),
  }[electronPlatformName];

  if (!executable || !fs.existsSync(executable)) {
    throw new Error(`Fuses : exécutable introuvable (${executable})`);
  }

  // La validation d'intégrité de app.asar exige que electron-builder ait pu écrire
  // l'empreinte dans les ressources de l'exe. Avec "signAndEditExecutable": false
  // (build depuis Linux sans wine), elle n'est PAS écrite : activer ce fuse
  // empêcherait alors l'application de démarrer (fenêtre qui ne s'ouvre jamais).
  // VoxForge n'utilise pas app.asar (modules natifs sherpa-onnx / node-llama-cpp et leurs DLL chargés
  // depuis node_modules, processus utilitaires lancés depuis src/) : les deux fuses liés à asar restent
  // désactivés, sinon l'application ne démarrerait pas. L'intégrité est assurée par l'empreinte SHA-256
  // de l'installeur (SHA256.txt) et par les fuses d'options Node (NODE_OPTIONS, --inspect) désactivés.
  const integrite = false;

  await flipFuses(executable, {
    version: FuseVersion.V1,
    resetAdHocDarwinSignature: electronPlatformName === 'darwin',
    // RunAsNode reste ACTIVÉ pour VoxForge : node-llama-cpp vérifie son binaire carte graphique (Vulkan)
    // dans un sous-processus lancé avec ELECTRON_RUN_AS_NODE. Désactivé, l'IA locale perd la carte
    // graphique ou ne démarre plus (vérifié sur la version empaquetée : NoBinaryFoundError).
    [FuseV1Options.RunAsNode]: true,
    [FuseV1Options.EnableCookieEncryption]: true,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: integrite,
    [FuseV1Options.OnlyLoadAppFromAsar]: false,
  });
  console.log(`Fuses appliqués sur ${path.basename(executable)} (intégrité asar : ${integrite ? 'oui' : 'non'}, RunAsNode : conservé pour node-llama-cpp)`);
};
