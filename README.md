# Common Suit

A web game about predicting everyone else's predictions. Choose a number card and a suit in secret, then see how well you read the table. Play head-to-head, with up to **160 players per room**, or practice against seven bots.

## Run locally

Requires **Node.js 24 or newer**. There are no third-party runtime dependencies, accounts, paid services, API keys, databases, or build steps.

```sh
npm ci
npm test
npm start
```

Open `http://localhost:3000` in a browser. Set `PORT` to change the listening port. `npm run dev` restarts the server when files change. For a multiplayer game, create a table, share its room code or invite link, and start when everyone has joined. On a local network, friends need your machine's reachable address; a localhost invite only works on your own machine.

## Rules, version 1

Everyone must acknowledge the rules before creating or joining a table. This is a game for points only; there are no bets, purchases, or cash prizes.

- A match has **six rounds**, with **30 seconds** to choose a card each round. A round ends early if all active players submit. There are eight seconds between rounds.
- Choose a whole number from **2 through 10**, and hearts, diamonds, clubs, or spades. Aces and face cards are excluded. Players have independent decks; multiple players may pick the same card.
- Each number can be used **once per match**, regardless of suit. Suits may be reused. A locked choice cannot be changed.
- Choices stay hidden from other players until the reveal. The submitted count is public. Each reveal shows all cards and the complete score calculation.
- A missed round scores **−15**, spends no number, and is excluded from the average and suit counts. If nobody submits, everyone receives −15 and there is no target or modal suit.
- The highest sum of round scores wins. Equal totals share the same rank. Reconnecting restores your seat; leaving a match forfeits subsequent rounds. Joining after a match starts is disabled.

### Exact scoring

For the `n` submitted cards, let `μ` be the arithmetic mean of their numbers and `M` the set of most chosen suits (all ties included).

```text
Target T = 2 + (2/3) × (μ − 2)
Number points V = max(0, 60 − 10 × |your number − T|)

B(your suit, modal suit) = 24 if they are identical
                         12 if different but the same color
                          0 if opposite colors

Suit points S = sum of B(your suit, m) for m in M / size of M
Crowding penalty C = 18 × (number choosing your suit − 1) / (n − 1)
                     (C = 0 when n = 1)

Round points = round(V + S − C to two decimal places)
Match score = sum of the rounded round points
```

Hearts and diamonds are red; clubs and spades are black. There is no random tiebreaker. Calculate with full precision, then round the final round score; displayed components may be rounded for readability. A round's score can be negative.

**Example:** the table plays 10♥, 7♦, 6♦, 5♠. The average is 7, so the target is 5⅓ and diamonds is the sole modal suit. The 10♥ receives 13⅓ number points, 12 suit points, and no crowding penalty: **25.33 points**. The 6♦ receives 53⅓ + 24 − 6 = **71.33 points**.

### Why these rules?

The number game is a shifted **two-thirds beauty contest**: predict the crowd's average, then reason one step below it. The shift keeps the target within the playable range. With unlimited reuse, repeated reasoning pushes toward 2; the one-use rule adds a **finite resource allocation** decision across six rounds. Low cards help now but may be worth saving. High cards are not equally attractive under this downward target; deciding which three numbers to leave unused is part of the game.

The suit game combines **coordination** (match the crowd) with **congestion** (sharing a suit costs points). If everyone chooses hearts, the suit contribution is 24 − 18 = 6; choosing diamonds instead may earn more. In a two-player game, different suits of the same color earn 18 suit points each, opposite colors earn 12 each, and identical suits net 6 each. These are deliberate incentives, not a claim of a solved equilibrium or tournament-tested balance. Bots mix random choices with adaptation to prior reveals; they do not inspect the current human choice.

## Deploy to the web

This requires a **long-running Node web service**. GitHub Pages and static-only hosting cannot run the multiplayer server.

The included `render.yaml` is a Render Blueprint: connect this repository to Render, create a Blueprint from it, review the service settings, and deploy. It uses `npm ci`, `npm start`, and `/health`. Alternatively, run those commands on any Node 24+ host that provides a public HTTPS address and forwards its assigned `PORT`. Share that public address with players. Hosting is a separate step from pushing the source to GitHub.

Use a **single process and single replica**. Rooms, scores, and session credentials are held in memory; a process restart/deploy clears them. Do not enable cluster mode or multiple replicas without adding shared storage and coordinated room timers. A disconnected player can rejoin the same seat using their browser's saved session while the server remains running. Idle rooms without connections expire after one hour, with up to 200 rooms per process. Capacity limits are guardrails, not a guarantee of 32,000 concurrent players on every host.

For reverse proxies, forward the original `Host`, allow streaming responses and disable buffering on `/api/rooms/*/events`. SSE heartbeats occur every 15 seconds. Avoid logging request query strings: the EventSource connection uses a bearer session token in its URL. Use HTTPS in production. A room code allows someone to join its lobby; it is not an account or an identity check. Browser sessions are anonymous and one-person-one-seat is not enforced.

## Development and validation

- `npm test` exercises the mathematical rules and actual HTTP multiplayer flows, including invalid input, choice secrecy, timeouts, reconnects, and room capacity.
- `npm run check` checks JavaScript syntax.
- `GET /health` returns `{ "ok": true }` when the web server is running. Actual play is validated separately by integration tests.
- `rules.js` is the pure scoring model; `server.mjs` owns rooms, authorization, timers, bots, and SSE; `public/` contains the browser UI. Tests use short injected timers; live matches use the published 30/8-second rules.

The server validates choices and rules consent, uses random session tokens, bounds request sizes and per-seat/IP request rates, and never publishes locked opponent cards. Player names are rendered as text. This is a casual game implementation; competitive identity, durable leaderboards, moderation, and distributed hosting are future extensions.
