# Security Policy

## Reporting a vulnerability

**Please report security issues privately — do not open a public issue or PR.**

Preferred channel: **GitHub private vulnerability reporting** — go to the
repository's **Security** tab, then choose **Report a vulnerability**.

Please include:

- what the issue is and its impact,
- steps to reproduce (a proof-of-concept helps), and
- any suggested fix.

We'll acknowledge your report as soon as we reasonably can and keep you updated on
the fix. Please give us a reasonable window to remediate before any public
disclosure.

## Cheats & game-integrity exploits

Instagib Arena is a competitive game, and the netcode is **server-authoritative**
(hits, movement limits, ranked Elo, and match results are decided server-side). If
you find a way to **cheat** — forge stats, bypass server validation, desync the
authoritative state, spoof scores/Elo, or otherwise gain an unfair advantage —
please treat it like a vulnerability and report it **privately** through the channel
above rather than demonstrating it on the live server or sharing it publicly.

Responsible testing: do not run denial-of-service, brute-force, or load attacks
against the production server (`instagib.win`). Test against a local build instead.

## Scope

The latest `main` branch and the production deployment are in scope. Findings in
third-party dependencies should generally be reported upstream, but let us know if
they affect this project so we can update.

Thank you for helping keep the arena fair and safe.
