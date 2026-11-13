# Contributing to GanttSmart

Thanks for your interest in contributing! Here's how to get started.

## Getting Started

1. Clone the repo and install dependencies: `npm ci` (or `npm install`)
2. For Supabase mode, copy `.env.example` to `.env`, fill in your Supabase and Linear credentials, and run `npm run dev`
3. For GCP local dev mode, run `npm run dev:server` (with `DEV_USER_EMAIL` and the other variables in `server/src/config.ts` set) alongside `VITE_BACKEND=gcp npm run dev`

## Development

- **Stack**: React, TypeScript, Vite, Tailwind CSS, Hono (GCP server)
- **Format check / fix**: `npm run format:check` / `npm run format` (Prettier)
- **Lint**: `npm run lint` (`eslint . --max-warnings 0`)
- **Type check & build**:
  - `npm run build` (`tsc -b && vite build`, Supabase default)
  - `VITE_BACKEND=gcp npm run build` (GCP build)
  - `npm run build:server` (`tsc -p tsconfig.server.json`)
- **Unit & server tests**: `npm test` (`vitest run`)
- **Browser tests (Chrome & Firefox)**: `npm run test:e2e` (`playwright test` against the built GCP app + server)

## Submitting Changes

1. Open or reference a Linear issue (`IT-*`) or GitHub issue first to discuss what you'd like to change
2. Create a branch from `main` (`git checkout -b feat/your-feature`) — direct pushes to `main` are blocked by the repository ruleset
3. Make your changes — keep PRs focused and small
4. Run the local checks before opening a PR:
   - `npm run format:check`
   - `npm run lint`
   - `npm run build`, `VITE_BACKEND=gcp npm run build`, and `npm run build:server`
   - `npm test`
   - `npm run test:e2e` (after building the GCP app and server)
5. Run a fresh-context subagent review of the diff against the issue/spec, including interactive browser testing (for example via Playwright MCP) whenever UI or runtime behavior changes, and fix any findings
6. Open a pull request against `main`

## CI & Review Process

- **Automated CI (Linux only):** Every PR and push to `main` runs `.github/workflows/ci.yml` on `ubuntu-24.04`:
  - `checks`: formatting, ESLint (`--max-warnings 0`), TypeScript + both frontend builds + server build, and `vitest run`
  - `browser (chrome)` and `browser (firefox)`: Playwright tests against the built GCP app and server
- **Merge requirements:** The `main protection` ruleset requires all three status checks (`checks`, `browser (chrome)`, `browser (firefox)`) to pass against up-to-date `main` before merging.
- **Interactive review:** Automated Playwright tests verify baseline flows; interactive testing of new UI or runtime behavior is still run by the subagent reviewer and summarized in the PR's `## Review` section before merge.

## Pull Request Guidelines

- Keep the title short and descriptive
- Reference the related issue (e.g., `Linear: IT-89` or `Closes #12`)
- Include a brief description of what changed and why, exact `## Verification` output, and a `## Review` summary
- Add screenshots for UI changes when helpful

## Reporting Bugs

Open an issue with:
- Steps to reproduce
- Expected vs actual behavior
- Browser and OS info
- Screenshots if applicable

## License

By contributing, you agree that your contributions will be licensed under the [AGPL-3.0 License](LICENSE).
