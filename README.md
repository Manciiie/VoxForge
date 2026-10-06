# VoxForge

Transcription audio et vidéo vers texte, 100 % locale, pour Windows (Electron).

- Moteurs : Parakeet v3, Whisper Large v3 Turbo et Large v3 (sherpa-onnx), carte graphique NVIDIA facultative.
- IA locale (node-llama-cpp, GGUF : Gemma 4, Gemma 3, Qwen 2.5) : résumé, traduction, nettoyage, fiches, questions sur les cours, détection d'origine IA.
- Textes importés (txt, docx, odt, pdf, srt…), projets, vocabulaire du cours, plan détecté automatiquement.

## Développement

```bash
npm install
npm start                       # lancer en développement
npm test                        # tests de sécurité
node scripts/scan-securite.js --complet
npm run build                   # installeur Windows (FORGE_MAJ_JETON=… pour les mises à jour)
node scripts/livrer.js --taille-partie 25
```

`resources/bin/ffmpeg.exe` (non versionné) est requis pour le build Windows. Les mises à jour sont publiées dans le dépôt privé `Manciiie/VoxForge-releases`.

Voir `CHANGELOG.md` et `SECURITE.md`.
