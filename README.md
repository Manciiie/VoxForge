# VoxForge

Transcription audio et vidéo vers texte, 100 % locale, pour Windows (Electron).

- Moteurs : Parakeet v3, Whisper Large v3 Turbo et Large v3 (sherpa-onnx), carte graphique NVIDIA facultative.
- IA locale (node-llama-cpp, GGUF : Gemma 4, Gemma 3, Qwen 2.5) : résumé, traduction, nettoyage, fiches, questions sur les cours, détection d'origine IA.
- Textes importés (txt, docx, odt, pdf, srt…), projets, vocabulaire du cours, plan détecté automatiquement.

## Construire l'installeur sur son PC (Windows)

1. Installer [Node.js](https://nodejs.org) LTS (version 20 ou plus).
2. Télécharger ce dépôt (Code → Download ZIP) et le décompresser.
3. Double-cliquer sur **`construire-setup.bat`**.

Le script installe les dépendances, prépare `ffmpeg.exe` (repris de VoxForge s'il est déjà installé, sinon téléchargé ; empreinte SHA-256 vérifiée) et produit **`dist\VoxForge-Setup-<version>.exe`**, un installeur en un seul fichier. Pour une version qui se met à jour toute seule, définir d'abord la variable d'environnement `FORGE_MAJ_JETON`.

## Développement

```bash
npm install
npm start                       # lancer en développement
npm test                        # tests de sécurité
node scripts/scan-securite.js --complet
npm run build                   # installeur Windows (FORGE_MAJ_JETON=… pour les mises à jour)
node scripts/livrer.js --taille-partie 25
```

`resources/bin/ffmpeg.exe` (non versionné) est placé par `node scripts/preparer-ffmpeg.js`. Les mises à jour sont publiées dans le dépôt privé `Manciiie/VoxForge-releases`.

Voir `CHANGELOG.md` et `SECURITE.md`.
