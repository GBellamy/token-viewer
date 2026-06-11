# Token Viewer

Dashboard local de consommation de tokens **Claude Code**, catégorisée et en quasi temps réel.

## Lancement

```sh
node server.js
# → http://localhost:3456
```

Zéro dépendance (Node ≥ 18). Chart.js et les polices sont chargés via CDN (connexion internet requise pour l'affichage).

## Ce que ça montre

- **Tokens par type** : input non caché / output / cache lu / cache écrit (coûts très différents : cache lu ≈ 0,1× input, cache écrit ≈ 1,25×).
- **Chronologie** empilée (par heure sur 24h–48h, par jour au-delà).
- **Par outil** : output généré par chaque outil + « croissance du contexte » (delta de taille de prompt attribué aux outils du message précédent — approximation).
- **Par modèle** : coût équivalent API.
- **Sessions récentes** par projet, avec part des sous-agents.

## Sources de données

`~/.claude/projects/<slug>/*.jsonl` et `<slug>/<session>/subagents/agent-*.jsonl`.
Chaque message assistant porte `message.usage` ; l'usage d'un même message étant répété
sur plusieurs lignes, la déduplication se fait par `message.id`. Un `fs.watch` récursif
pousse les mises à jour au navigateur via SSE.

## Limites connues

- Le **coût est un équivalent tarif API** — les abonnements (Pro/Max) ne facturent pas au token.
- Les **limites d'usage** (fenêtre 5 h / quota hebdo) ne sont pas exposées par Claude Code en local — non affichées pour l'instant (phase 4 potentielle via endpoint non documenté).
- L'attribution de la croissance de contexte par outil est une approximation (les tours utilisateur et la compaction la perturbent à la marge).
