# Contributing to Instagib Arena

Thanks for your interest — bug reports, ideas, and pull requests are all welcome.

## Ways to contribute

- **Report a bug or suggest a feature** — use the in-game **Send feedback** button
  (it goes straight to the admin panel) or
  [open a GitHub issue](https://github.com/8tp/instagib-arena/issues/new/choose).
- **Send a pull request** — fix a bug, add a map/mode/cosmetic, improve the netcode
  or the docs.

## Development setup

Requires **Node ≥ 20.19**. See the [README](README.md#quick-start):

```bash
npm install
npm run dev
```

## Before you open a PR

- Run **`npm run lint`** and **`npm run typecheck`** — both must pass.
- **Match the surrounding code.** This codebase favors small, well-commented,
  dependency-free solutions (e.g. SQLite via prepared statements, hand-rolled SVG
  charts, no ORM). Don't add a dependency without discussing it first.
- Keep PRs focused — one logical change per PR is much easier to review.
- For gameplay/netcode changes, describe how you tested (and ideally include a clip).

## Branch & PR flow

1. Fork the repo and create a branch off `main`.
2. Make your change; commit with a clear message.
3. Open a PR against `main` describing **what** changed and **why**.

## Contributor License Agreement (CLA)

Instagib Arena is open source under the AGPL-3.0, and the maintainer also offers
commercial/dual licenses. So that contributions don't cloud those rights, all
contributors must agree to the [Contributor License Agreement](CLA.md). For now,
confirm agreement with the CLA checkbox in the pull request template.

In short: you keep ownership of your contribution, and you grant the maintainer a
license to use, distribute, and relicense it (including under a commercial
license) as part of the project. You only contribute work you have the right to.

## Security & anti-cheat

This is a competitive game. **Do not post working cheats or exploits in public
issues/PRs.** If you find a vulnerability or a way to cheat, report it privately —
see [SECURITY.md](SECURITY.md).

## Code of Conduct

Participation is governed by our [Code of Conduct](CODE_OF_CONDUCT.md).
