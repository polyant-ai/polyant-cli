# Working on polyant-cli

`AGENTS.md` is the guide for agents that drive the CLI and ships in the npm package,
so the contributor instructions live here and in `CONTRIBUTING.md`. Read `AGENTS.md`
before changing a command: it is the contract the CLI keeps with its users.

## Working practice

- Inspect the code, tests and history before editing; follow the neighbouring command
  and its `*.test.ts`.
- Make it work, then make it good: before asking for review, simplify — reuse what
  exists, remove duplication and dead code, keep the diff small.
- Verify with `npm run typecheck`, `npm test`, `npm run build` and
  `node dist/bin.js --version`; report what could not run.
- Branch from `develop` as `feat/…`, `fix/…`, `feature/…`, `bugfix/…` or `hotfix/…`
  (other names are rejected) and open the PR to `develop`; `main` and `develop` are
  protected. Write the PR in English with `.github/PULL_REQUEST_TEMPLATE.md`.
- Never merge, tag, publish or deploy unless explicitly asked.
