# Motrix Next Contributing Guide

Maintained by [@AnInsomniacy](https://github.com/AnInsomniacy). PRs and issues are welcome!

Before you start contributing, make sure you understand [GitHub flow](https://guides.github.com/introduction/flow/).

## 🛠 Development Setup

### Prerequisites

- [Rust](https://rustup.rs/) (latest stable)
- [Node.js](https://nodejs.org/) >= 22
- [pnpm](https://pnpm.io/) >= 9

### Getting Started

```bash
git clone https://github.com/AnInsomniacy/motrix-next.git
cd motrix-next
pnpm install
pnpm tauri dev    # Start dev server (Tauri + Vite)
```

Rust backend (standalone):

```bash
cd src-tauri
cargo build
cargo test
```

## ✅ Code Quality

All checks must pass before PR merge:

```bash
pnpm lint               # ESLint (0 errors, 0 warnings)
pnpm test               # Vitest
npx vue-tsc --noEmit    # TypeScript strict mode
npx vite build          # Production build (no chunk warnings)
cd src-tauri && cargo test  # Rust tests
```

Pre-commit hooks (husky + lint-staged) auto-run `eslint --fix` and `prettier --write` on staged files.

## 📐 Component Guidelines

- **Max 250 lines** per `.vue` SFC. Extract sub-components when approaching this limit.
- Use `<script setup lang="ts">` with composition API.
- Every file starts with a `/** @fileoverview ... */` doc comment.
- Use `logger` from `@shared/logger` for all runtime logging — **no bare `console.*`**.

## 🛡 Error Handling

- **TypeScript**: Never leave `catch` blocks empty — always call `logger.debug()` at minimum.
- **Rust**: Use the `AppError` enum (`Store`, `Engine`, `Io`, `NotFound`, `Updater`, `Upnp`) for all command return types.

## 🧪 Testing

- Follow **TDD** (Red → Green → Refactor) for new utilities and guards.
- Test files live alongside source: `__tests__/filename.test.ts`.
- Runtime type guards (in `guards.ts`) validate all external API responses.

## 🌍 Translation Guide

First you need to determine the English abbreviation of a language as **locale**, such as `en-US`. This locale value should strictly refer to the [Chromium Source Code](https://source.chromium.org/chromium/chromium/src/+/main:ui/base/l10n/l10n_util.cc).

The internationalization of Motrix Next uses [vue-i18n](https://vue-i18n.intlify.dev/).

The configuration files are divided by **locale** under `src/shared/locales/`, such as `src/shared/locales/en-US` and `src/shared/locales/zh-CN`.

There are language files in each directory organized by business module:

- `about.js`
- `app.js`
- `edit.js`
- `help.js`
- `index.js`
- `menu.js`
- `preferences.js`
- `subnav.js`
- `task.js`
- `window.js`

### Adding a New Language

1. Create a new directory under `src/shared/locales/` with the locale code (e.g. `src/shared/locales/de/`)
2. Copy the files from `src/shared/locales/en-US/` as a template
3. Translate each file
4. Register the locale in `src/shared/locales/all.js`
5. Submit a Pull Request

## 💬 Commit Messages

Use [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add torrent file selection
fix: handle empty bitfield in peer parser
refactor: extract TorrentUpload sub-component
test: add rename utility tests
docs: update CONTRIBUTING guidelines
```

## 🤝 Pull Requests

- Fork the repo and create your branch from `main`
- If you've added code, ensure TypeScript compiles without errors (`npx vue-tsc --noEmit`)
- Make sure your code follows the existing style
- Write a clear PR description

## 📜 License

By contributing, you agree that your contributions will be licensed under the [MIT License](https://opensource.org/licenses/MIT).
