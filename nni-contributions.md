# LibreChat Fork Usage Guidelines – Network Ninja

This document outlines how developers at Network Ninja should work with our fork of [danny-avila/LibreChat](https://github.com/danny-avila/LibreChat). It ensures that we can contribute cleanly upstream while preserving company-specific modifications in a separate development stream.

---

## Overview

- The `main` branch is kept **clean and in sync** with the upstream `LibreChat` repository.
- Our internal modifications live in a separate branch: `nni-main`.
- Upstream contributions **must** be based off `main` and exclude company-specific changes.

---

## 📦 Repo Setup Instructions

1. **Clone the repo:**

   ```bash
   git clone git@github.com:networkninja/librechat.git
   cd librechat
   ```

2. **Add the upstream remote:**

   ```bash
   git remote add upstream https://github.com/danny-avila/LibreChat.git
   ```

3. **Verify remotes:**

   ```bash
   git remote -v
   # Should list origin (networkninja fork) and upstream (danny-avila)
   ```

---

## 🧪 Development Setup

Follow the official [CONTRIBUTING.md](https://github.com/danny-avila/LibreChat/blob/main/.github/CONTRIBUTING.md) from upstream for:

- Node version requirements
- Dependency installation
- TypeScript compilation
- Unit and integration testing

Make sure all changes adhere to the steps in the **Development Setup**, **Development Notes**, **Commit Format**, and **Testing** sections.

---

## 🚫 Do Not Commit to `main`

- The `main` branch **tracks upstream**.
- Never commit directly to `main`. Never push company-specific features to `main`.
- Use the `nni-main` branch for internal features or deployments.

---

## ✅ How to Contribute Code Upstream

1. **Start from a clean `main`:**

   ```bash
   git checkout main
   git pull upstream main
   ```

2. **Create a new feature branch off `main`**

   ```bash
   git checkout -b feature/short-description
   ```

   > ⚠️ Follow the branch naming conventions listed in the [Formatting & Naming Conventions](#-formatting--naming-conventions) section below.

3. **Make your changes** and ensure they meet the upstream guidelines:

   - Follow commit conventions: `feat: add X`, `fix: correct Y`
   - Do not include NNI ticket numbers in your commit messages for features being sent back to upstream.
   - Run linting, tests, and builds
   - Clear localStorage and cookies in your browser if your feature touches auth, session handling, or persistent app settings. This ensures you're not affected by stale values during testing.

4. **Rebase and squash as needed:**

   ```bash
   git rebase -i main
   ```

5. **Push your feature branch to origin:**

   ```bash
   git push origin feature/short-description
   ```

6. **Open a PR upstream:**

   - Go to `https://github.com/danny-avila/LibreChat/compare/main...networkninja:LibreChat:main`
   - Use your branch as the head
   - Describe the changes clearly, referencing related issues, following the contribution guidelines for LibreChat

7. **Follow Upstream Review Guidelines:**

   - All features must be approved via discussion or tied to an issue
   - Engage with feedback on GitHub or in the [Discord community](https://discord.librechat.ai)

---

## 🏗️ Working on Internal Features

1. **Start from `nni-main`:**

   ```bash
   git checkout nni-main
   git pull origin nni-main
   ```

2. **Create a descriptive feature branch:**

   ```bash
   git checkout -b internal/your-feature-name
   ```

3. **Implement and test locally.**

4. **Merge back into `nni-main` once validated:**

   ```bash
   git checkout nni-main
   git merge internal/your-feature-name
   git push origin nni-main
   ```

---

## 🔁 Syncing `main` with Upstream

> ⚠️ **Warning**: This will completely replace your local `main` with the latest from upstream and discard any uncommitted changes or local commits.

To keep your local and forked `main` up to date:

```bash
git checkout main
git fetch upstream
git reset --hard upstream/main
# DANGER: This will remove all local changes in main!
git push origin main --force
```

> This ensures future PRs are based on an accurate upstream history.

---

## 📋 Quick Checklist for Upstream PRs

-

---

## 🧼 Formatting & Naming Conventions

- **Branch names:** `feature/x`, `fix/bug`, `internal/xyz`
- **Commit types:** `feat`, `fix`, `docs`, `refactor`, `test`, `chore`
- **Code style:** Lint before committing: `npm run lint`
- **Tests:** Unit and integration tests must pass

---

## Need Help?

- Join the [LibreChat Discord](https://discord.librechat.ai)
- Tag @josh or the dev lead in Slack

---

By following these guidelines, we keep our internal work organized while contributing cleanly and respectfully to the upstream community.

