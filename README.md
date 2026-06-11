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

## Limites d'abonnement (jauges)

Affichées en haut du dashboard : fenêtre 5 h, quota hebdo global et par modèle, avec heure de réinitialisation.
Récupérées via l'endpoint `api.anthropic.com/api/oauth/usage` avec le token OAuth local
(`~/.claude/.credentials.json`) — **endpoint non documenté**, le panneau disparaît proprement s'il casse.
Rafraîchi toutes les 60 s, mis en cache côté serveur.

## Catégorisation officielle (OpenTelemetry)

Le serveur embarque un récepteur OTLP/HTTP JSON (`POST /v1/metrics`). Quand la télémétrie de
Claude Code est activée (bloc `env` dans `~/.claude/settings.json`, voir l'état vide du dashboard),
il reçoit `claude_code.token.usage` et expose les dimensions officielles : **main / sous-agent /
auxiliaire**, **skill** et **type d'agent**. Les compteurs cumulatifs sont convertis en deltas et
persistés dans `data/otel.ndjson`. Ne concerne que les sessions démarrées après activation.

## Limites connues

- Le **coût est un équivalent tarif API** — les abonnements (Pro/Max) ne facturent pas au token.
- L'attribution de la croissance de contexte par outil est une approximation (les tours utilisateur et la compaction la perturbent à la marge).
- L'endpoint des limites est non documenté et peut changer sans préavis (dégradation propre prévue).
